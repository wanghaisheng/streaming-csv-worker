
const IS_WORKER = false,
	IS_PAPA_WORKER = false
var workers = {}, workerIdCounter = 0;
import { default as PapaDefault } from 'papaparse'

var Papa = {}

Papa.parse = CsvToJson
Papa.unparse = PapaDefault.unparse;

Papa.RECORD_SEP = String.fromCharCode(30);
Papa.UNIT_SEP = String.fromCharCode(31);
Papa.BYTE_ORDER_MARK = '\ufeff';
Papa.BAD_DELIMITERS = ['\r', '\n', '"', Papa.BYTE_ORDER_MARK];
Papa.WORKERS_SUPPORTED = false
Papa.NODE_STREAM_INPUT = 1;

// Configurable chunk sizes for local and remote files, respectively
Papa.LocalChunkSize = 1024 * 1024 * 10;	// 10 MB
Papa.RemoteChunkSize = 1024 * 1024 * 5;	// 5 MB
Papa.DefaultDelimiter = ',';			// Used if not specified and detection fails

// Exposed for testing and development only
Papa.Parser = PapaDefault.Parser;
Papa.ParserHandle = ParserHandle;
Papa.NetworkStreamer = NetworkStreamer;





function CsvToJson(_input, _config): any {
	_config = _config || {};
	var dynamicTyping = _config.dynamicTyping || false;
	if (isFunction(dynamicTyping)) {
		_config.dynamicTypingFunction = dynamicTyping;
		// Will be filled on first row call
		dynamicTyping = {};
	}
	_config.dynamicTyping = dynamicTyping;

	_config.transform = isFunction(_config.transform) ? _config.transform : false;


	var streamer = null;
	if (typeof _input !== 'string' || !_config.download) {
		return PapaDefault.parse(_input, _config)
	}

	return new NetworkStreamer(_config).stream(_input);
}




/** ChunkStreamer is the base prototype for various streamer implementations. */
class ChunkStreamer {
	constructor(config) {
		this._handle = null;
		this._finished = false;
		this._completed = false;
		this._halted = false;
		this._input = null;
		this._baseIndex = 0;
		this._partialLine = '';
		this._rowCount = 0;
		this._start = 0;
		//this._nextChunk = null;
		this.isFirstChunk = true;
		this._completeResults = {
			data: [],
			errors: [],
			meta: {}
		};
		this.replaceConfig(config);
	}
	_nextChunk() {
		this._readChunk();	// Starts streaming
	}
	parseChunk(chunk, isFakeChunk) {

		// First chunk pre-processing
		if (this.isFirstChunk && isFunction(this._config.beforeFirstChunk)) {
			var modifiedChunk = this._config.beforeFirstChunk(chunk);
			if (modifiedChunk !== undefined)
				chunk = modifiedChunk;
		}
		this.isFirstChunk = false;
		this._halted = false;

		// Rejoin the line we likely just split in two by chunking the file
		var aggregate = this._partialLine + chunk;
		this._partialLine = '';

		var results = this._handle.parse(aggregate, this._baseIndex, !this._finished);

		if (this._handle.paused() || this._handle.aborted()) {
			this._halted = true;
			//	console.log('_halted')
			return;
		}

		var lastIndex = results.meta.cursor;

		if (!this._finished) {
			this._partialLine = aggregate.substring(lastIndex - this._baseIndex);
			this._baseIndex = lastIndex;
		}

		if (results && results.data)
			this._rowCount += results.data.length;

		var finishedIncludingPreview = this._finished || (this._config.preview && this._rowCount >= this._config.preview);



		if (!this._config.step && !this._config.chunk) {
			//console.trace('config dstep')
			this._completeResults.data = this._completeResults.data.concat(results.data);
			this._completeResults.errors = this._completeResults.errors.concat(results.errors);
			this._completeResults.meta = results.meta;
		}

		if (!this._completed && finishedIncludingPreview && isFunction(this._config.complete) && (!results || !results.meta.aborted)) {
			//console.log('sin resultados')
			this._config.complete(this._completeResults, this._input);
			this._completed = true;
		}

		if (!finishedIncludingPreview && (!results || !results.meta.paused)) {
			//console.log(!finishedIncludingPreview)
			this._nextChunk();
		}


		return results;
	}



	replaceConfig(config) {
		// Deep-copy the config so we can edit it
		var configCopy = copy(config);
		configCopy.chunkSize = parseInt(configCopy.chunkSize);	// parseInt VERY important so we don't concatenate strings!
		if (!config.step && !config.chunk)
			configCopy.chunkSize = null;  // disable Range header if not streaming; bad values break IIS - see issue #196
		this._handle = new ParserHandle(configCopy);
		this._handle.streamer = this;
		this._config = configCopy;	// persist the copy to the caller
	}
}

/**
 * Modified streamer, replacing XMLHttpRequest with fetch
 */
class NetworkStreamer extends ChunkStreamer {
	constructor(config = {}) {
		super({ chunkSize: Papa.RemoteChunkSize, ...config })


		this.decoder = new TextDecoder();
	}

	async _getReader() {
		if (this.reader) return Promise.resolve(this.reader)
		let req = new Request(this._input, {
			method: this._config.downloadRequestBody ? 'POST' : 'GET'
		})

		if (this._config.withCredentials) {
			req.credentials = this._config.withCredentials;
		}



		if (this._config.downloadRequestBody) {
			req.body = this._config.downloadRequestBody
		}

		// Headers can only be set when once the request state is OPENED
		if (this._config.downloadRequestHeaders) {
			var headers = this._config.downloadRequestHeaders;

			for (var headerName in headers) {
				req.headers.set(headerName, headers[headerName]);
			}
		}

		if (this._config.chunkSize) {
			var end = this._start + this._config.chunkSize - 1;	// minus one because byte range is inclusive
			req.headers.set('Range', 'bytes=' + this._start + '-' + end);
		}
		const res = await fetch(req)
		//console.log(Object.fromEntries(res.headers))
		this.reader = res.body.getReader()
		return this.reader
	}


	_nextChunk() {
		this._readChunk();	// Starts streaming
	}

	stream(url) {
		this._input = url;
		this._readChunk();	// Starts streaming
	}

	async _readChunk() {
		if (this._finished) {
			this._chunkLoaded({ done: true, value: null });
			return;
		}
		this._getReader().then(thisReader => {
			return thisReader.read().then(({ done, value }) => {


				this._chunkLoaded({ done, value });

			})
		})
	}
	_chunkLoaded({ done, value }) {

		let chunkText = this.decoder.decode(value)

		this._finished = done


		this.parseChunk(chunkText);
	}

	_chunkError(errorMessage) {
		var errorText = xhr.statusText || errorMessage;
		this._sendError(new Error(errorText));
	}


}








// Use one ParserHandle per entire CSV file or string
function ParserHandle(_config) {
	// One goal is to minimize the use of regular expressions...
	var MAX_FLOAT = Math.pow(2, 53);
	var MIN_FLOAT = -MAX_FLOAT;
	var FLOAT = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/;
	var ISO_DATE = /^(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))$/;
	var self = this;
	var _stepCounter = 0;	// Number of times step was called (number of rows parsed)
	var _rowCounter = 0;	// Number of rows that have been parsed so far
	var _input;				// The input being parsed
	var _parser;			// The core parser being used
	var _paused = false;	// Whether we are paused or not
	var _aborted = false;	// Whether the parser has aborted or not
	var _delimiterError;	// Temporary state between delimiter detection and processing results
	var _fields = [];		// Fields are from the header row of the input, if there is one
	var _results = {		// The last results returned from the parser
		data: [],
		errors: [],
		meta: {}
	};

	if (isFunction(_config.step)) {
		var userStep = _config.step;
		_config.step = function (results) {
			_results = results;

			if (needsHeaderRow())
				processResults();
			else	// only call user's step function after header row
			{
				processResults();

				// It's possbile that this line was empty and there's no row here after all
				if (_results.data.length === 0)
					return;

				_stepCounter += results.data.length;
				if (_config.preview && _stepCounter > _config.preview)
					_parser.abort();
				else {
					_results.data = _results.data[0];
					userStep(_results, self);
				}
			}
		};
	}

	/**
	 * Parses input. Most users won't need, and shouldn't mess with, the baseIndex
	 * and ignoreLastRow parameters. They are used by streamers (wrapper functions)
	 * when an input comes in multiple chunks, like from a file.
	 */
	this.parse = function (input, baseIndex, ignoreLastRow) {
		var quoteChar = _config.quoteChar || '"';
		if (!_config.newline)
			_config.newline = guessLineEndings(input, quoteChar);

		_delimiterError = false;
		if (!_config.delimiter) {
			var delimGuess = guessDelimiter(input, _config.newline, _config.skipEmptyLines, _config.comments, _config.delimitersToGuess);
			if (delimGuess.successful)
				_config.delimiter = delimGuess.bestDelimiter;
			else {
				_delimiterError = true;	// add error after parsing (otherwise it would be overwritten)
				_config.delimiter = Papa.DefaultDelimiter;
			}
			_results.meta.delimiter = _config.delimiter;
		}
		else if (isFunction(_config.delimiter)) {
			_config.delimiter = _config.delimiter(input);
			_results.meta.delimiter = _config.delimiter;
		}

		var parserConfig = copy(_config);
		if (_config.preview && _config.header)
			parserConfig.preview++;	// to compensate for header row

		_input = input;
		_parser = new PapaDefault.Parser(parserConfig);
		_results = _parser.parse(_input, baseIndex, ignoreLastRow);
		processResults();
		return _paused ? { meta: { paused: true } } : (_results || { meta: { paused: false } });
	};

	this.paused = function () {
		return _paused;
	};

	this.pause = function () {
		_paused = true;
		_parser.abort();

		// If it is streaming via "chunking", the reader will start appending correctly already so no need to substring,
		// otherwise we can get duplicate content within a row
		_input = isFunction(_config.chunk) ? "" : _input.substring(_parser.getCharIndex());
	};

	this.resume = function () {
		if (self.streamer._halted) {
			_paused = false;
			self.streamer.parseChunk(_input, true);
		} else {
			// Bugfix: #636 In case the processing hasn't halted yet
			// wait for it to halt in order to resume
			setTimeout(self.resume, 3);
		}
	};

	this.aborted = function () {
		return _aborted;
	};

	this.abort = function () {
		_aborted = true;
		_parser.abort();
		_results.meta.aborted = true;
		if (isFunction(_config.complete))
			_config.complete(_results);
		_input = '';
	};

	function testEmptyLine(s) {
		return _config.skipEmptyLines === 'greedy' ? s.join('').trim() === '' : s.length === 1 && s[0].length === 0;
	}

	function testFloat(s) {
		if (FLOAT.test(s)) {
			var floatValue = parseFloat(s);
			if (floatValue > MIN_FLOAT && floatValue < MAX_FLOAT) {
				return true;
			}
		}
		return false;
	}

	function processResults() {
		if (_results && _delimiterError) {
			addError('Delimiter', 'UndetectableDelimiter', 'Unable to auto-detect delimiting character; defaulted to \'' + Papa.DefaultDelimiter + '\'');
			_delimiterError = false;
		}

		if (_config.skipEmptyLines) {
			for (var i = 0; i < _results.data.length; i++)
				if (testEmptyLine(_results.data[i]))
					_results.data.splice(i--, 1);
		}

		if (needsHeaderRow())
			fillHeaderFields();

		return applyHeaderAndDynamicTypingAndTransformation();
	}

	function needsHeaderRow() {
		return _config.header && _fields.length === 0;
	}

	function fillHeaderFields() {
		if (!_results)
			return;

		function addHeader(header, i) {
			if (isFunction(_config.transformHeader))
				header = _config.transformHeader(header, i);

			_fields.push(header);
		}

		if (Array.isArray(_results.data[0])) {
			for (var i = 0; needsHeaderRow() && i < _results.data.length; i++)
				_results.data[i].forEach(addHeader);

			_results.data.splice(0, 1);
		}
		// if _results.data[0] is not an array, we are in a step where _results.data is the row.
		else
			_results.data.forEach(addHeader);
	}

	function shouldApplyDynamicTyping(field) {
		// Cache function values to avoid calling it for each row
		if (_config.dynamicTypingFunction && _config.dynamicTyping[field] === undefined) {
			_config.dynamicTyping[field] = _config.dynamicTypingFunction(field);
		}
		return (_config.dynamicTyping[field] || _config.dynamicTyping) === true;
	}

	function parseDynamic(field, value) {
		if (shouldApplyDynamicTyping(field)) {
			if (value === 'true' || value === 'TRUE')
				return true;
			else if (value === 'false' || value === 'FALSE')
				return false;
			else if (testFloat(value))
				return parseFloat(value);
			else if (ISO_DATE.test(value))
				return new Date(value);
			else
				return (value === '' ? null : value);
		}
		return value;
	}

	function applyHeaderAndDynamicTypingAndTransformation() {
		if (!_results || (!_config.header && !_config.dynamicTyping && !_config.transform))
			return _results;

		function processRow(rowSource, i) {
			var row = _config.header ? {} : [];

			var j;
			for (j = 0; j < rowSource.length; j++) {
				var field = j;
				var value = rowSource[j];

				if (_config.header)
					field = j >= _fields.length ? '__parsed_extra' : _fields[j];

				if (_config.transform)
					value = _config.transform(value, field);

				value = parseDynamic(field, value);

				if (field === '__parsed_extra') {
					row[field] = row[field] || [];
					row[field].push(value);
				}
				else
					row[field] = value;
			}


			if (_config.header) {
				if (j > _fields.length)
					addError('FieldMismatch', 'TooManyFields', 'Too many fields: expected ' + _fields.length + ' fields but parsed ' + j, _rowCounter + i);
				else if (j < _fields.length)
					addError('FieldMismatch', 'TooFewFields', 'Too few fields: expected ' + _fields.length + ' fields but parsed ' + j, _rowCounter + i);
			}

			return row;
		}

		var incrementBy = 1;
		if (!_results.data.length || Array.isArray(_results.data[0])) {
			_results.data = _results.data.map(processRow);
			incrementBy = _results.data.length;
		}
		else
			_results.data = processRow(_results.data, 0);


		if (_config.header && _results.meta)
			_results.meta.fields = _fields;

		_rowCounter += incrementBy;
		return _results;
	}

	function guessDelimiter(input, newline, skipEmptyLines, comments, delimitersToGuess) {
		var bestDelim, bestDelta, fieldCountPrevRow, maxFieldCount;

		delimitersToGuess = delimitersToGuess || [',', '\t', '|', ';', Papa.RECORD_SEP, Papa.UNIT_SEP];

		for (var i = 0; i < delimitersToGuess.length; i++) {
			var delim = delimitersToGuess[i];
			var delta = 0, avgFieldCount = 0, emptyLinesCount = 0;
			fieldCountPrevRow = undefined;

			var preview = new PapaDefault.Parser({
				comments: comments,
				delimiter: delim,
				newline: newline,
				preview: 10
			}).parse(input);

			for (var j = 0; j < preview.data.length; j++) {
				if (skipEmptyLines && testEmptyLine(preview.data[j])) {
					emptyLinesCount++;
					continue;
				}
				var fieldCount = preview.data[j].length;
				avgFieldCount += fieldCount;

				if (typeof fieldCountPrevRow === 'undefined') {
					fieldCountPrevRow = fieldCount;
					continue;
				}
				else if (fieldCount > 0) {
					delta += Math.abs(fieldCount - fieldCountPrevRow);
					fieldCountPrevRow = fieldCount;
				}
			}

			if (preview.data.length > 0)
				avgFieldCount /= (preview.data.length - emptyLinesCount);

			if ((typeof bestDelta === 'undefined' || delta <= bestDelta)
				&& (typeof maxFieldCount === 'undefined' || avgFieldCount > maxFieldCount) && avgFieldCount > 1.99) {
				bestDelta = delta;
				bestDelim = delim;
				maxFieldCount = avgFieldCount;
			}
		}

		_config.delimiter = bestDelim;

		return {
			successful: !!bestDelim,
			bestDelimiter: bestDelim
		};
	}

	function guessLineEndings(input, quoteChar) {
		input = input.substring(0, 1024 * 1024);	// max length 1 MB
		// Replace all the text inside quotes
		var re = new RegExp(escapeRegExp(quoteChar) + '([^]*?)' + escapeRegExp(quoteChar), 'gm');
		input = input.replace(re, '');

		var r = input.split('\r');

		var n = input.split('\n');

		var nAppearsFirst = (n.length > 1 && n[0].length < r[0].length);

		if (r.length === 1 || nAppearsFirst)
			return '\n';

		var numWithN = 0;
		for (var i = 0; i < r.length; i++) {
			if (r[i][0] === '\n')
				numWithN++;
		}

		return numWithN >= r.length / 2 ? '\r\n' : '\r';
	}

	function addError(type, code, msg, row) {
		var error = {
			type: type,
			code: code,
			message: msg
		};
		if (row !== undefined) {
			error.row = row;
		}
		_results.errors.push(error);
	}
}

/** https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions */
function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}








function notImplemented() {
	throw new Error('Not implemented.');
}



/** Makes a deep copy of an array or object (mostly) */
function copy(obj) {
	if (typeof obj !== 'object' || obj === null)
		return obj;
	var cpy = Array.isArray(obj) ? [] : {};
	for (var key in obj)
		cpy[key] = copy(obj[key]);
	return cpy;
}

function bindFunction(f, self) {
	return function () { f.apply(self, arguments); };
}

function isFunction(func) {
	return typeof func === 'function';
}

export default Papa;

