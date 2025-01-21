'use strict';

// Use a fork of pouchdb-mapreduce, which allows us
// deeper control over what's persisted, without needing ddocs
var mapReduce = require('pouchdb-mapreduce-no-ddocs');
Object.keys(mapReduce).forEach(function (key) {
  exports[key] = mapReduce[key];
});

var utils = require('./pouch-utils');
var lunr = require('lunr');
var uniq = require('uniq');
var Promise = utils.Promise;
var stringify = require('json-stable-stringify');

var indexes = {};

var TYPE_TOKEN_COUNT = 'a';
var TYPE_DOC_INFO = 'b';

function add(left, right) {
  return left + right;
}

// get all the tokens found in the given text (non-unique)
// in the future, we might expand this to do more than just
// English. Also, this is a private Lunr API, hence why
// the Lunr version is pegged.
function getTokenStream(text, pipeline, is_query = false) {
  // Lunr 0.x -> 2.x Tokens are now instances of lunr.Token, not just strings,
  // so the uniq call on this array was not really working.

  var trimmer;
  var stemmers = [];
  for (var i = 0, len = pipeline._stack.length; i < len; i++) {
    if (pipeline._stack[i].label.indexOf('trimmer') >= 0) {
      trimmer = pipeline._stack[i];
    } else if (pipeline._stack[i].label.indexOf('stemmer') >= 0) {
      stemmers.push(pipeline._stack[i]);
    }
  }

  var trimmed_tokens = lunr.tokenizer(text).map(function(token) {
    if (is_query && token.toString().indexOf('*') >= 0) {
      return token.toString();
    } else {
      return trimmer(token).toString();
    }
  });

  var results_2;

  if (is_query) {
    results_2 = trimmed_tokens.map(function(s) {
      var t = new lunr.Token(s);
      for (var i = 0, len = stemmers.length; i < len; i++) {
        stemmers[i](t);
      }
      return t.toString();

      //return stemmer(new lunr.Token(s)).toString();
    })
  } else {
    results_2 = trimmed_tokens.concat(
      trimmed_tokens.map(function(s) {
        var t = new lunr.Token(s);
        for (var i = 0, len = stemmers.length; i < len; i++) {
          stemmers[i](t);
        }
        return t.toString();
        //return stemmer(new lunr.Token(s)).toString();
      })
    )
  }

  return results_2;

  //return pipeline.run(lunr.tokenizer(text)).map(function(x) { return x.toString(); });
}

// given an object containing the field name and/or
// a deepField definition plus the doc, return the text for
// indexing
function getText(fieldBoost, doc) {
  var text;
  if (!fieldBoost.deepField) {
    text = doc[fieldBoost.field];
  } else { // "Enhance."
    text = doc;
    for (var i = 0, len = fieldBoost.deepField.length; i < len; i++) {
      if (Array.isArray(text)) {
        text = text.map(handleNestedObjectArrayItem(fieldBoost, fieldBoost.deepField.slice(i)));
      } else {
        text = text && text[fieldBoost.deepField[i]];
      }
    }
  }
  if (text) {
    if (Array.isArray(text)) {
      text = text.join(' ');
    } else if (typeof text !== 'string') {
      text = text.toString();
    }
  }
  return text;
}

function handleNestedObjectArrayItem(fieldBoost, deepField) {
  return function (one) {
    return getText(utils.extend({}, fieldBoost, {
      deepField: deepField
    }), one);
  };
}

// map function that gets passed to map/reduce
// emits two types of key/values - one for each token
// and one for the field-len-norm
function createMapFunction(fieldBoosts, index, filter, db) {
  return function (doc, emit) {

    if (isFiltered(doc, filter, db)) {
      return;
    }

    var docInfo = [];

    for (var i = 0, len = fieldBoosts.length; i < len; i++) {
      var fieldBoost = fieldBoosts[i];

      var text = fieldBoost.getText ? fieldBoost.getText(doc) : getText(fieldBoost, doc);

      var fieldLenNorm;
      if (text) {
        var terms = uniq(getTokenStream(text, index.pipeline));
        for (var j = 0, jLen = terms.length; j < jLen; j++) {
          var term = terms[j];
          // avoid emitting the value if there's only one field;
          // it takes up unnecessary space on disk
          var value = fieldBoosts.length > 1 ? i : undefined;
          emit(TYPE_TOKEN_COUNT + term, value);
        }
        fieldLenNorm = Math.sqrt(terms.length);
      } else { // no tokens
        fieldLenNorm = 0;
      }
      docInfo.push(fieldLenNorm);
    }

    emit(TYPE_DOC_INFO + doc._id, docInfo);
  };
}

exports.search = utils.toPromise(function (opts, callback) {
  var pouch = this;
  opts = utils.extend(true, {}, opts);
  var q = opts.query || opts.q;
  var mm = 'mm' in opts ? (parseFloat(opts.mm) / 100) : 1; // e.g. '75%'
  var fields = opts.fields;
  var highlighting = opts.highlighting;
  var includeDocs = opts.include_docs;
  var destroy = opts.destroy;
  var stale = opts.stale;
  var limit = opts.limit;
  var build = opts.build;
  var lunrOptions = build ? opts.lunrOptions : null;
  var skip = opts.skip || 0;
  var language = opts.language || 'en';
  var filter = opts.filter;
  var getText = opts.getText || {};

  if (Array.isArray(fields)) {
    var fieldsMap = {};
    fields.forEach(function (field) {
      fieldsMap[field] = 1; // default boost
    });
    fields = fieldsMap;
  }

  var fieldBoosts = Object.keys(fields).map(function (field) {
    var deepField = field.indexOf('.') !== -1 && field.split('.');
    return {
      field: field,
      getText: getText[field],
      deepField: deepField,
      boost: fields[field]
    };
  });

  var index = indexes[language];
  var indexPipeline;
  if (!index) {
    index = indexes[language] = lunr(function() {
      /* istanbul ignore next */
      lunrOptions && lunrOptions.bind(this)(lunr);
      indexPipeline = this.pipeline;
      if (Array.isArray(language)) {
        this.use(lunr['multiLanguage'].apply(this, language));
      } else if (language !== 'en') {
        this.use(lunr[language]);
      }
    });
    index.searchPipeline = indexPipeline; //index.pipeline;
    index.pipeline = indexPipeline;
  }

  // the index we save as a separate database is uniquely identified
  // by the fields the user want to index (boost doesn't matter)
  // plus the tokenizer

  var indexParams = {
    language: language,
    fields: fieldBoosts.map(function (x) {
      return x.field;
    }).sort()
  };

  if (filter) {
    indexParams.filter = filter.toString();
  }

  var persistedIndexName = 'search-' + utils.MD5(stringify(indexParams));

  var mapFun = createMapFunction(fieldBoosts, index, filter, pouch);

  var queryOpts = {
    saveAs: persistedIndexName
  };
  if (destroy) {
    queryOpts.destroy = true;
    return pouch._search_query(mapFun, queryOpts, callback);
  } else if (build) {
    delete queryOpts.stale; // update immediately
    queryOpts.limit = 0;
    pouch._search_query(mapFun, queryOpts).then(function () {
      callback(null, {ok: true});
    }).catch(callback);
    return;
  }

  // it shouldn't matter if the user types the same
  // token more than once, in fact I think even Lucene does this
  // special cases like boingo boingo and mother mother are rare
  var queryTerms = uniq(getTokenStream(q, index.searchPipeline, true));
  if (!queryTerms.length) {
    return callback(null, {total_rows: 0, rows: []});
  }
  queryOpts.keys = queryTerms.map(function (queryTerm) {
    return TYPE_TOKEN_COUNT + queryTerm;
  });

  if (typeof stale === 'string') {
    queryOpts.stale = stale;
  }
  //
  // Wildcards
  // 1. Detect if the query term contains an asterisk
  // 2. Remove keys property from the queryOpts
  // 3. Perform _search_query with limit (100?)
  // 4. Match the key with the query term.
  // 5. If wildcard is in the front, compare last n chars of both strings
  // 6. If wildcard is in the back, compare first n strings of both strings
  // 7. If wildcard is in the middle, compare first n and last n of both strings.

  // 1. Split the query terms on '*'. Are there any query terms with a wildcard?
  // ＊
  var wildcardTerms = queryTerms.filter(function(queryTerm) {
    var sections = queryTerm.split('*');
    // Term needs to contain something other than '*'.
    return sections.length > 1 && sections.filter(function(s) {
      return s.length > 0;
    }).length > 0;
  });
  var hasWildCard = wildcardTerms.length > 0;

  if (hasWildCard) {
    var total_rows = 0;
    var docIdsToFieldsToQueryTerms = {};
    delete queryOpts.keys;
    // For v0 let's not bother setting a limit.
    return pouch._search_query(mapFun, queryOpts).then(function (res) {
      return res.rows.filter(function(d) {
        var text = d.key.substring(1),
            term = wildcardTerms[0],
            sections = term.split("*");
        return matchWildcard(term, sections, text);
      });
    // Copied from step 3 below.
    }).then(function (rows) {
      total_rows = rows.length;
      // filter before fetching docs or applying highlighting
      // for a slight optimization, since for now we've only fetched ids/scores
      return (typeof limit === 'number' && limit >= 0) ?
        rows.slice(skip, skip + limit) : skip > 0 ? rows.slice(skip) : rows;
    }).then(function (rows) {
      if (includeDocs) {
        return applyIncludeDocs(pouch, rows);
      }
      return rows;
    }).then(function (rows) {
      if (highlighting) {
        return applyHighlighting(pouch, opts, rows, fieldBoosts, docIdsToFieldsToQueryTerms);
      }
      return rows;

    }).then(function (rows) {
      callback(null, {total_rows: total_rows, rows: rows});
    });
  }

  // search algorithm, basically classic TF-IDF
  //
  // step 1: get the doc+fields associated with the terms in the query
  // step 2: get the doc-len-norms of those document fields
  // step 3: calculate document scores using tf-idf
  //
  // note that we follow the Lucene convention (established in
  // DefaultSimilarity.java) of computing doc-len-norm (in our case, tecnically
  // field-lennorm) as Math.sqrt(numTerms),
  // which is an optimization that avoids having to look up every term
  // in that document and fully recompute its scores based on tf-idf
  // More info:
  // https://lucene.apache.org/core/3_6_0/api/core/org/apache/lucene/search/Similarity.html
  //

  // step 1
  pouch._search_query(mapFun, queryOpts).then(function (res) {

    if (!res.rows.length) {
      return callback(null, {total_rows: 0, rows: []});
    }
    var total_rows = 0;
    var docIdsToFieldsToQueryTerms = {};
    var termDFs = {};

    res.rows.forEach(function (row) {
      var term = row.key.substring(1);
      var field = row.value || 0;

      // calculate termDFs
      if (!(term in termDFs)) {
        termDFs[term] = 1;
      } else {
        termDFs[term]++;
      }

      // calculate docIdsToFieldsToQueryTerms
      if (!(row.id in docIdsToFieldsToQueryTerms)) {
        var arr = docIdsToFieldsToQueryTerms[row.id] = [];
        for (var i = 0; i < fieldBoosts.length; i++) {
          arr[i] = {};
        }
      }

      var docTerms = docIdsToFieldsToQueryTerms[row.id][field];
      if (!(term in docTerms)) {
        docTerms[term] = 1;
      } else {
        docTerms[term]++;
      }
    });

    // apply the minimum should match (mm)
    if (queryTerms.length > 1) {
      Object.keys(docIdsToFieldsToQueryTerms).forEach(function (docId) {
        var allMatchingTerms = {};
        var fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
        Object.keys(fieldsToQueryTerms).forEach(function (field) {
          Object.keys(fieldsToQueryTerms[field]).forEach(function (term) {
            allMatchingTerms[term] = true;
          });
        });
        var numMatchingTerms = Object.keys(allMatchingTerms).length;
        var matchingRatio = numMatchingTerms / queryTerms.length;
        if ((Math.floor(matchingRatio * 100) / 100) < mm) {
          delete docIdsToFieldsToQueryTerms[docId]; // ignore this doc
        }
      });
    }

    if (!Object.keys(docIdsToFieldsToQueryTerms).length) {
      return callback(null, {total_rows: 0, rows: []});
    }

    var keys = Object.keys(docIdsToFieldsToQueryTerms).map(function (docId) {
      return TYPE_DOC_INFO + docId;
    });

    var queryOpts = {
      saveAs: persistedIndexName,
      keys: keys,
      stale: stale
    };

    // step 2
    return pouch._search_query(mapFun, queryOpts).then(function (res) {

      var docIdsToFieldsToNorms = {};
      res.rows.forEach(function (row) {
        docIdsToFieldsToNorms[row.id] = row.value;
      });
      // step 3
      // now we have all information, so calculate scores
      var rows = calculateDocumentScores(queryTerms, termDFs,
        docIdsToFieldsToQueryTerms, docIdsToFieldsToNorms, fieldBoosts);
      return rows;
    }).then(function (rows) {
      total_rows = rows.length;
      // filter before fetching docs or applying highlighting
      // for a slight optimization, since for now we've only fetched ids/scores
      return (typeof limit === 'number' && limit >= 0) ?
        rows.slice(skip, skip + limit) : skip > 0 ? rows.slice(skip) : rows;
    }).then(function (rows) {
      if (includeDocs) {
        return applyIncludeDocs(pouch, rows);
      }
      return rows;
    }).then(function (rows) {
      if (highlighting) {
        return applyHighlighting(pouch, opts, rows, fieldBoosts, docIdsToFieldsToQueryTerms);
      }
      return rows;

    }).then(function (rows) {
      callback(null, {total_rows: total_rows, rows: rows});
    });
  }).catch(callback);
});


// returns a sorted list of scored results, like:
// [{id: {...}, score: 0.2}, {id: {...}, score: 0.1}];
//
// some background: normally this would be implemented as cosine similarity
// using tf-idf, which is equal to
// dot-product(q, d) / (norm(q) * norm(doc))
// (although there is no point in calculating the query norm,
// because all we care about is the relative score for a given query,
// so we ignore it, lucene does this too)
//
//
// but instead of straightforward cosine similarity, here I implement
// the dismax algorithm, so the doc score is the
// sum of its fields' scores, and this is done on a per-query-term basis,
// then the maximum score for each of the query terms is the one chosen,
// i.e. max(sumOfQueryTermScoresForField1, sumOfQueryTermScoresForField2, etc.)
//

function calculateDocumentScores(queryTerms, termDFs, docIdsToFieldsToQueryTerms,
                                 docIdsToFieldsToNorms, fieldBoosts) {

  var results = Object.keys(docIdsToFieldsToQueryTerms).map(function (docId) {

    var fieldsToQueryTerms = docIdsToFieldsToQueryTerms[docId];
    var fieldsToNorms = docIdsToFieldsToNorms[docId];

    var queryScores = queryTerms.map(function (queryTerm) {
      return fieldsToQueryTerms.map(function (queryTermsToCounts, fieldIdx) {
        var fieldNorm = fieldsToNorms[fieldIdx];
        if (!(queryTerm in queryTermsToCounts)) {
          return 0;
        }
        var termDF = termDFs[queryTerm];
        var termTF = queryTermsToCounts[queryTerm];
        var docScore = termTF / termDF; // TF-IDF for doc
        var queryScore = 1 / termDF; // TF-IDF for query, count assumed to be 1
        var boost = fieldBoosts[fieldIdx].boost;
        return docScore * queryScore * boost / fieldNorm; // see cosine sim equation
      }).reduce(add, 0);
    });

    var maxQueryScore = 0;
    queryScores.forEach(function (queryScore) {
      if (queryScore > maxQueryScore) {
        maxQueryScore = queryScore;
      }
    });

    return {
      id: docId,
      score: maxQueryScore
    };
  });

  results.sort(function (a, b) {
    return a.score < b.score ? 1 : (a.score > b.score ? -1 : 0);
  });

  return results;
}

function applyIncludeDocs(pouch, rows) {
  return Promise.all(rows.map(function (row) {
    return pouch.get(row.id);
  })).then(function (docs) {
    docs.forEach(function (doc, i) {
      rows[i].doc = doc;
    });
  }).then(function () {
    return rows;
  });
}

// create a convenient object showing highlighting results
// this is designed to be like solr's highlighting feature, so it
// should return something like
// {'fieldname': 'here is some <strong>highlighted text</strong>.'}
//
function applyHighlighting(pouch, opts, rows, fieldBoosts,
                           docIdsToFieldsToQueryTerms) {

  var pre = opts.highlighting_pre || '<strong>';
  var post = opts.highlighting_post || '</strong>';

  return Promise.all(rows.map(function (row) {

    return Promise.resolve().then(function () {
      if (row.doc) {
        return row.doc;
      }
      return pouch.get(row.id);
    }).then(function (doc) {
      row.highlighting = {};
      docIdsToFieldsToQueryTerms[row.id].forEach(function (queryTerms, i) {
        var fieldBoost = fieldBoosts[i];
        var fieldName = fieldBoost.field;
        var text = getText(fieldBoost, doc);
        // TODO: this is fairly naive highlighting code; could improve
        // the regex
        Object.keys(queryTerms).forEach(function (queryTerm) {
          var regex = new RegExp('(' + queryTerm + '[a-z]*)', 'gi');
          var replacement = pre + '$1' + post;
          text = text.replace(regex, replacement);
          row.highlighting[fieldName] = text;
        });
      });
    });
  })).then(function () {
    return rows;
  });
}

// return true if filtered, false otherwise
// limit the try/catch to its own function to avoid deoptimization
function isFiltered(doc, filter, db) {
  try {
    return !!(filter && !filter(doc));
  } catch (e) {
    db.emit('error', e);
    return true;
  }
}

function matchWildcard(term, sections, text) {
  // Supports *oobar foo*ar fooba*
  // ;; TODO: Support *ooba*
  // var sections = term.split("*");
  if (term[0] === '*' && term[term.length - 1] === '*' && sections.length === 3) {
    var matchable = sections[1],
        hasMatch = false;
    for (var i = 0, len = text.length - matchable.length; i < len; i++) {
      if (text.substring(i, i + matchable.length) === matchable) {
        hasMatch = true;
        break;
      }
    }
    return hasMatch;
  } else if (sections.length > 2) {
    return false;
  } else {
    var front = sections[0],
        back  = sections[1];
    // TODO Don't need to check both here.
    var matchFront = text.substring(0, front.length) === front;
    var matchBack = text.substring(text.length - back.length) === back;
    return matchFront && matchBack;
  }
}

/* istanbul ignore next */
if (typeof PouchDB !== 'undefined') {
  PouchDB.plugin(exports);
}
