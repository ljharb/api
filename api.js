#!/usr/bin/env node

'use strict';

var test = require('tape');
var path = require('path');
var fs = require('fs');
var existsSync = path.existsSync || fs.existsSync;
var spawn = require('child_process').spawn;

var args = process.argv.slice(2); // remove node, and script name

var argEquals = function (argName) {
	return function (arg) {
		return arg === argName;
	};
};
var not = function (fn) {
	return function () {
		return !fn.apply(this, arguments);
	};
};
var isArg = function (x) {
	return x.slice(0, 2) === '--';
};

var isBound = args.some(argEquals('--bound'));
var isProperty = args.some(argEquals('--property'));
var skipShimPolyfill = args.some(argEquals('--skip-shim-returns-polyfill'));
var skipAutoShim = args.some(argEquals('--skip-auto-shim'));
var isMulti = args.some(argEquals('--multi'));

var makeEntries = function (name) {
	return [name, name];
};
var moduleNames = args.filter(not(isArg)).map(makeEntries);

if (moduleNames.length < 1) {
	var packagePath = path.join(process.cwd(), 'package.json');
	if (!existsSync(packagePath)) {
		console.error('Error: No package.json found in the current directory');
		console.error('at least one module name is required when not run in a directory with a package.json');
		process.exit(1);
	}
	var pkg = require(packagePath);
	if (!pkg.name) {
		console.error('Error: No "name" found in package.json');
		process.exit(2);
	}
	moduleNames.push([pkg.name + ' (current directory)', [path.join(process.cwd(), pkg.main || ''), process.cwd()]]);
}
var requireOrEvalError = function (name) {
	try {
		return require(name);
	} catch (e) {
		return new EvalError(e.message);
	}
};
var testAuto = function testAutoModule(t, prefix, packageDir, asMulti) {
	t.test(prefix + 'auto', function (st) {
		var msg = 'auto is present';
		if (skipAutoShim) {
			st.comment('# SKIP ' + msg);
			st.end();
		} else {
			require(path.join(packageDir, '/auto'));
			st.comment(msg + ' (pass `--skip-auto-shim` to skip this test)');
			var proc = spawn(path.join(__dirname, asMulti ? 'multiAutoTest.js' : 'autoTest.js'), [], { cwd: packageDir, stdio: 'inherit' });
			st.plan(1);
			proc.on('close', function (code) {
				st.equal(code, 0, 'auto invokes shim');
			});
		}
	});
};
var doValidation = function doActualValidation(t, packageDir, name) {
	var module = requireOrEvalError(name);
	if (module instanceof EvalError) {
		return module;
	}
	var implementation = requireOrEvalError(packageDir + '/implementation');
	var shim = requireOrEvalError(packageDir + '/shim');
	var getPolyfill = requireOrEvalError(packageDir + '/polyfill');

	var prefix = isMulti ? path.basename(packageDir) + ': ' : '';

	t.test(prefix + 'export', function (st) {
		st.equal(typeof module, 'function', 'module is a function');
		st.test('module is NOT bound (pass `--bound` to skip this test)', { skip: isBound }, function (st2) {
			st2.equal(module, getPolyfill(), 'module.exports === getPolyfill()');
			st2.end();
		});
		st.end();
	});

	t.test(prefix + 'implementation', function (st) {
		if (isMulti) {
			st.comment('# SKIP module.exports.implementation === implementation.js');
		} else {
			st.equal(implementation, module.implementation, 'module.exports.implementation === implementation.js');
		}
		if (isProperty) {
			st.comment('# SKIP implementation that is a data property need not be a function');
		} else {
			st.equal(typeof implementation, 'function', 'implementation is a function (pass `--property` to skip this test)');
		}
		st.end();
	});

	t.test(prefix + 'polyfill', function (st) {
		if (isMulti) {
			st.comment('# SKIP module.exports.getPolyfill === polyfill.js');
		} else {
			st.equal(getPolyfill, module.getPolyfill, 'module.exports.getPolyfill === polyfill.js');
		}
		st.equal(typeof getPolyfill, 'function', 'getPolyfill is a function');
		st.end();
	});

	t.test(prefix + 'shim', function (st) {
		if (isMulti) {
			st.comment('# SKIP module.exports.shim === shim.js');
		} else {
			st.equal(shim, module.shim, 'module.exports.shim === shim.js');
		}
		st.equal(typeof shim, 'function', 'shim is a function');
		if (typeof shim === 'function') {
			var msg = 'shim returns polyfill (pass `--skip-shim-returns-polyfill` to skip this test)';
			if (skipShimPolyfill) {
				st.comment('# SKIP ' + msg);
			} else {
				st.equal(shim(), getPolyfill(), msg);
			}
		}
		st.end();
	});

	testAuto(t, prefix, packageDir, false);

	return void undefined;
};

var validateModule = function validateAPIModule(t, nameOrFilePaths) {
	var name = nameOrFilePaths;
	var packageDir = nameOrFilePaths;
	if (Array.isArray(nameOrFilePaths)) {
		name = nameOrFilePaths[0];
		packageDir = nameOrFilePaths[1];
	}
	if (isMulti) {
		var subPackages = requireOrEvalError(name);
		if (subPackages instanceof EvalError) {
			return subPackages;
		}
		t.ok(Array.isArray(subPackages), 'main export is an array of sub packages');
		t.deepEqual(
			Object.keys(subPackages),
			subPackages.map(function (_, i) { return String(i); }),
			'main export has no additional properties'
		);
		t.ok(subPackages.length > 0, 'array is not empty');

		var dirs = fs.readdirSync(packageDir).filter(function (d) {
			return !d.startsWith('.')
				&& d !== 'node_modules'
				&& d !== 'helpers'
				&& d !== 'test'
				&& fs.statSync(d).isDirectory();
		});
		t.deepEqual(subPackages, dirs, 'main export subpackages matches dirs in the package root');

		var shim = requireOrEvalError(packageDir + '/shim');
		t.equal(typeof shim, 'function', 'root shim is a function');
		testAuto(t, 'root: ', packageDir, true);

		var implementation = requireOrEvalError('./implementation');
		t.ok(implementation instanceof EvalError, 'root lacks an `implementation` module');

		subPackages.forEach(function (subPackage) {
			var subPackageDir = path.join(path.dirname(name), subPackage);
			doValidation(t, subPackageDir, subPackageDir);
		});
	} else {
		doValidation(t, packageDir, name);
	}

	return void undefined;
};

moduleNames.forEach(function (data) {
	var name = data[0];
	var filePath = data[1];
	test('es-shim API : testing module: ' + name, function (t) {
		t.comment('* ----------------------------- * #');
		t.error(validateModule(t, filePath), 'expected no error');
		t.end();
	});
});
