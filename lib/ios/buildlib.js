/**
 * build library utility for xcode / ios platform
 */
var exec = require('child_process').exec,
	spawn = require('child_process').spawn,
	path = require('path'),
	fs = require('fs'),
	async = require('async'),
	_ = require('underscore'),
	log = require('../log'),
	debug = false,
	settings,
	xcodepath,
	sysframeworks;

/**
 * return the currently configured active xcode path
 */
function getXcodePath(callback) {
	if (xcodepath) {
		return callback(null,xcodepath);
	}
	var cmd = "/usr/bin/xcode-select -print-path";
	exec(cmd, function(err, stdout, stderr){
		err && callback(new Error(stderr));
		callback(null,(xcodepath=stdout.trim()));
	});
}

/**
 * get the system frameworks
 */
function getSystemFrameworks(callback) {
	if (sysframeworks) {
		return callback(null, sysframeworks);
	}
	getXcodeSettings(function(err,settings){
		if (err) return callback(err);
		var r = /\.framework$/,
			frameworkDir = path.join(settings.simSDKPath,'System','Library','Frameworks');
		fs.readdir(frameworkDir, function(err,paths) {
			if (err) return callback(err);
			sysframeworks = _.filter(paths,function(v) { 
				if (r.test(v) && fs.existsSync(path.join(frameworkDir,v,'Headers'))) {
					return v;
				}
			});
			callback(null, sysframeworks);
		});
	});
}

/**
 * get the current Xcode settings such as paths for build tools
 */
function getXcodeSettings (callback) {
	if (settings) {
		return callback(null,settings);
	}
	getXcodePath(function(err,xcode){
		err && console.error(err) && process.exit(1);
		var devicePath = path.join(xcode,'Platforms','iPhoneOS.platform'),
			simPath = path.join(xcode,'Platforms','iPhoneSimulator.platform'),
			simSDKsDir = path.join(simPath,'Developer','SDKs'),
			deviceSDKsDir = path.join(devicePath,'Developer','SDKs'),
			usrbin = path.join(xcode,'Toolchains','XcodeDefault.xctoolchain','usr','bin'),
			clang = path.join(usrbin,'clang'),
			libtool = path.join(usrbin, 'libtool'),
			lipo = path.join(usrbin, 'lipo'),
			otool = path.join(usrbin, 'otool');

		var sdks = fs.readdirSync(deviceSDKsDir);
		if (sdks.length===0) {
			return callback(new Error('no SDKs found at '+deviceSDKsDir));
		}
		var versions = [];
		sdks.forEach(function(f){
			var v = f.replace('.sdk','').replace('iPhoneOS','');
			versions.push(v);
		});
		versions = versions.length > 1 ? versions.sort() : versions;
		var version = versions[versions.length-1],
			simSDKPath = path.join(simSDKsDir, 'iPhoneSimulator'+version+'.sdk'),
			deviceSDKPath = path.join(deviceSDKsDir, 'iPhoneOS'+version+'.sdk');

		callback(null,(settings = { 
			xcodePath: xcode,
			version: version,
			clang: clang,
			libtool: libtool,
			lipo: lipo,
			otool: otool,
			simSDKPath: simSDKPath,
			deviceSDKPath: deviceSDKPath
		}));
	});
}

/**
 * create a command function wrapper
 */
function createFn (cmd) {
	return function(callback) {
		debug && console.log(cmd);
		exec(cmd,callback)
	}
}

/**
 * utility to check the results of a async task and 
 * throw Error or print to console on output / debug
 */
function checkResults(err,results,callback) {
	if (err) return callback(new Error(err)) && false;
	var stderr = [],
		stdout = [];
	results.forEach(function(result){
		result[0] && stdout.push(String(result[0]));
		result[1] && stderr.push(String(result[1]));
	});
	if (stderr.length) return callback(new Error(stderr.join('\n'))) && false;
	if (stdout.length) console.log(stdout.join('\n'));
	return true;
}

function staticlib(config, callback) {

	var minVersion = config.minVersion, 
		libname = config.libname, 
		objfiles = config.objfiles || {}, // will error below 
		outdir = config.outdir, 
		linkflags = config.linkflags || [],
		linkTasks = [],
		libfiles = {};

	if (Object.keys(objfiles).length===0) {
		return callback(new Error('no object file(s) specified'));
	}
	if (!fs.existsSync(outdir)) {
		fs.mkdir(outdir);
	}

	getXcodeSettings(function(err,settings){
		var archs = [],
			sdks = {
				'i386': {path: settings.simSDKPath, name:'ios-simulator'},
				'armv7': {path: settings.deviceSDKPath, name:'iphoneos'}
			};

		minVersion = minVersion || settings.version;
		config.debug && log.debug('setting minimum iOS version to', minVersion);

		Object.keys(sdks).forEach(function(sdk){

			var sdkObj = sdks[sdk],
				sysRoot = sdkObj.path,
				sdkName = sdkObj.name,
				dir = path.join(outdir, sdk),
				objs = objfiles[sdk],
				minOSString = '-m'+sdkName+'-version-min='+minVersion;

			if (!objs||objs.length===0) return;

			// create temp build directory for each platform
			if (!fs.existsSync(dir)) {
				fs.mkdir(dir);
			}

			var libFile = path.join(outdir, libname.replace(/\.a$/,'-'+sdk+'.a')),
				linkCmd = settings.libtool + ' ' + linkflags.join(' ') + ' -static -arch_only ' + sdk + ' -syslibroot ' + sysRoot + ' ' + objs.join(' ') + ' -o ' + libFile,
				fn = createFn(linkCmd);

			archs.push('-arch '+sdk+' '+libFile);
			linkTasks.push(fn);
			libfiles[sdk] = libFile;
			config.debug && log.debug('static lib command: ',objs.join(',').cyan,'to',libFile.cyan);
			config.debug && log.debug(linkCmd);
		});

		// link all the files
		async.parallel(linkTasks, function(err,results) {
			if (checkResults(err,results,callback)) {
				// lipo together all the static libraries
				var libfile = path.join(outdir, libname),
					lipoCmd = settings.lipo + ' -create ' + archs.join(' ') + ' -output ' + libfile;
				exec(lipoCmd, function(err, stdout, stderr) {
					if (err) return callback(new Error(err));
					debug && (stdout=String(stdout).trim()) && console.log(stdout);
					if ((stderr=String(stderr).trim()) && stderr) return new Error(err);
					// done!
					callback(null, libfile, libfiles);
				});
			}
		});

	});
}

function getModuleCacheDir() {
	var homeDir = path.join(process.env['HOME']),
		moduleCache = path.join(homeDir,'Library','Developer','Xcode','DerivedData','ModuleCache');
	return moduleCache;
}

function getDefaultCompilerArgs() {
	return [
		'-O0',
		'-fobjc-abi-version=2','-fobjc-legacy-dispatch',
		'-fobjc-arc','-fpascal-strings','-fexceptions','-fasm-blocks','-fstrict-aliasing',
		'-fmessage-length=0','-fdiagnostics-show-note-include-stack','-fmacro-backtrace-limit=0',
		'-fmodules','-fmodules-cache-path='+getModuleCacheDir()
	];
}

function compile(config, callback) {

	var minVersion = config.minVersion, 
		srcfiles = config.srcfiles || [], // will error below 
		outdir = config.outdir, 
		cflags = config.cflags || [], 
		error = false;

	if (!srcfiles || srcfiles.length===0) {
		return callback(new Error('no source(s) specified'));
	}
	if (!fs.existsSync(outdir)) {
		fs.mkdir(outdir);
	}

	getXcodeSettings(function(err,settings){
		var compileTasks = [],
			objfiles_by_os = {},
			deletefiles = [],
			template = getDefaultCompilerArgs(),
			sdks = {
				'i386': {path: settings.simSDKPath, name:'ios-simulator'},
				'armv7': {path: settings.deviceSDKPath, name:'iphoneos'}
			}

		minVersion = minVersion || settings.version;
		config.debug && log.debug('setting minimum iOS version to', minVersion);

		Object.keys(sdks).forEach(function(sdk){
			if (error) return;

			objfiles_by_os[sdk] = [];

			var sdkObj = sdks[sdk],
				sysRoot = sdkObj.path,
				sdkName = sdkObj.name,
				dir = path.join(outdir, sdk),
				minOSString = '-m'+sdkName+'-version-min='+minVersion;

			// create temp build directory for each platform
			if (!fs.existsSync(dir)) {
				fs.mkdir(dir);
			}

			// collect all the source compile commands
			srcfiles.forEach(function(src){
				if (error) return;

				if (!fs.existsSync(src)) {
					error=true;
					return callback(new Error("couldn't find source file: "+src));
				}

				var lang = 'objective-c',
					basename = path.basename(src);

				if (/\.cpp$/.test(basename)) {
					// we need to rename to .mm for clang to compile
					// just copy into our temp dir
					var tmp = path.join(dir, path.basename(src).replace(/\.cpp$/,'.mm')),
						srcContents = fs.readFileSync(src);
					fs.writeFileSync(tmp,srcContents);
					src = tmp;
					deletefiles.push(tmp); // so it can be deleted (otherwise rmdir fails)
					// switch to objective-c++
					lang = 'objective-c++';
				}
				else if (/\.mm$/.test(basename)) {
					// switch to objective-c++
					lang = 'objective-c++';
				}

				var outfile = path.join(dir, basename.replace(/\.m[m]?$/,'.o')),
					cmd = template.concat(cflags).concat([minOSString]).concat(['-c','-o']).concat([outfile, src]).join(' '),
					compileCmd = settings.clang + ' -x ' + lang + ' -arch ' + sdk + ' -isysroot ' + sysRoot + ' ' + cmd,
					fn = createFn(compileCmd);

				config.debug && log.debug('compiling ',src.cyan,'to',outfile.cyan);
				objfiles_by_os[sdk].push(outfile);
				compileTasks.push(fn);
				config.debug && log.debug('compile command: ',compileCmd.cyan);
			});

			if (error) return;

		});

		// compile all the files
		!error && async.parallel(compileTasks, function(err,results) {
			if (checkResults(err,results,callback)) {
				if (deletefiles.length) {
					async.map(deletefiles,fs.unlink,function(err,results){
						callback(null, objfiles_by_os);
					});
				}
				else {
					callback(null, objfiles_by_os);	
				}
			}			
		});

	});
}

/**
 * perform a one-step compile of a set of sources and then link them
 * into a universal shared library
 */
function compileAndMakeStaticLib(options, callback) {
	compile(options, function(err, objfiles_by_os) {
		if (err) return callback(err);
		options.objfiles = objfiles_by_os;
		staticlib(options, function(err, libfile, libfiles) {
			if (err) return callback(err);
			callback(null, {
				objfiles: objfiles_by_os,
				libfile: libfile,
				libfiles: libfiles
			});
		});
	});
}

function clang(file, minVersion, nativeArgs, callback) {
	getXcodeSettings(function(err,settings){
		if (err) return callback(err);

		var args = getDefaultCompilerArgs().concat(nativeArgs||[]),
			stdout = '',
			stderr = '';

		args.push('-arch');
		args.push('i386');
		args.push('-mios-simulator-version-min='+minVersion);
		args.push('-isysroot');
		args.push(settings.simSDKPath);
		args.push('-x');
		args.push('objective-c');
		args.push('-Xclang');
		args.push('-ast-dump');
		args.push('--analyze');
		args.push('-fno-color-diagnostics');
		args.push('-fretain-comments-from-system-headers')
		args.push(file);

		log.debug('clang arguments are: ',args.join(" ").grey);

		var process = spawn(settings.clang, args);
		process.stdout.on('data',function(buf){
			stdout+=buf.toString();
		});
		process.stderr.on('data',function(buf){
			stderr+=buf.toString();
		});
		process.on('close', function(exitCode){
			if (stderr) {
				return callback(new Error(stderr));
			}
			callback(null, stdout);
		});
	});
}

exports.getXcodePath = getXcodePath;
exports.getXcodeSettings = getXcodeSettings;
exports.getSystemFrameworks = getSystemFrameworks;
exports.compile = compile;
exports.staticlib = staticlib;
exports.clang = clang;
exports.compileAndMakeStaticLib = compileAndMakeStaticLib;

exports.__defineGetter__('debug', function(){
	return debug;
});
exports.__defineSetter__('debug',function(v){
	debug = v;
});

if (module.id === ".") {
	try {
		//debug = true;
		var build_dir = path.join(__dirname,'..','..','build'),
			srcdir = path.join(__dirname,'..','..','test','src'),
			srcfiles = fs.readdirSync(srcdir).map(function(f){return path.join(srcdir,f)});

		var config = {
			minVersion:'7.0',
			libname: 'libfoo.a', 
			srcfiles: srcfiles, 
			outdir: build_dir, 
			cflags: ['-DFOO'], 
			linkflags: ['-framework Foundation']
		};

/*
		compile(config, function(err, objfiles){
			err && console.error(err.toString().trim()) && process.exit(1);
			console.log('Compiled succeeded!\n',objfiles)
			config.objfiles = objfiles;
			staticlib(config, function(err,libfile,libfiles){
				console.log('Link succeeded! ',libfile,libfiles);
			});
		});
*/
		compileAndMakeStaticLib(config, function(err,results){
			console.log(results)
		});

	}
	catch(E){
		console.error(E);
	}
}