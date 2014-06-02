/*
 * Packager
 */
var	hyperloop = require('../../lib/dev').require('hyperloop-common'),
	Command = hyperloop.Command,
	fs = require('fs'),
	path = require('path'),
	log = hyperloop.log,
	util = hyperloop.util,
	_ = require('underscore'),
	exec = require('child_process').exec,
	wrench = require('wrench'),
	async = require('async'),
	os = require('os'),
	programs = require('../../lib/programs'),
	appc = require('node-appc'),
	sdkConfigs = {
		'8.1': {
			version: '3',
			checksum: 'ff61004236fc1141fdcf1a133c300f3deb70fdc1'
		}
	},
	urlFormat = 'http://timobile.appcelerator.com.s3.amazonaws.com/jscore/JavaScriptCore-windows-sdk%s-v%s.zip';

module.exports = new Command(
	'package',
	'Package the application for Windows',
	[
	],
	function(state,done) {
		var options = state.options;

		if (process.platform !== 'win32') {
			log.fatal('Packaging a Windows app requires being run on Windows.');
		}
		var osVersion = +os.release().split('.').slice(0, -1).join('.');
		if (osVersion < 6.2) {
			log.fatal('Packaging a Windows app requires Windows 8.1 or higher.');
		}
		var foundVisualStudio = false;
		for (var key in process.env) {
			if (process.env.hasOwnProperty(key)) {
				var match = key.match(/^VS(\d+)COMNTOOLS$/i);
				if (match && +match[1] >= 110) {
					foundVisualStudio = true;
					break;
				}
			}
		}
		if (!foundVisualStudio) {
			log.fatal('Packaging a Windows app requires Visual Studio 2012 or higher.');
		}
		if (!sdkConfigs[options.sdk]) {
			log.fatal("Please specify a --sdk of " + Object.keys(sdkConfigs).join(', ') + ".");
		}

		pkg(options, done);
	}
);

function generateCerts (options, proceed) {

	log.debug('generating certificates');

	var name = options.name,
		appDir = path.join(options.dest,'vsstudio',name),
		pvkPath = path.join(appDir, options.name+'_Key.pvk'),
		pfxPath = options.pfx && path.join(appDir, options.pfx),
		homeDir = util.writableHomeDirectory(),
		cerFile = path.join(appDir, 'Test_Key.cer'),
		solutionFile = path.join(appDir, '..', name + '.sln'),
		projectFile = path.join(appDir, name + '.vcxproj'),
		jscDir = path.join(homeDir, 'JavaScriptCore' + options.sdk),
		srcDir = appc.fs.resolvePath(options.src);

	var values = {
			APPNAME: name,
			APPGUID: options.appguid,
			LIBDIR: path.resolve(path.join(jscDir)).replace('/', '\\'),
			INCLUDEDIR: path.resolve(path.join(jscDir, 'include')).replace('/', '\\'),
			CERTNAME: options.certname,
			PFX: options.pfx,
			PUBLISHERNAME: options.publisher
		},
		configFile = path.join(appDir,'..','config.json'),
		config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {},
		packageJSONPath = path.join(srcDir, 'package.json'),
		packageJSON = !fs.existsSync(packageJSONPath) ? {} : JSON.parse(fs.readFileSync(packageJSONPath, 'utf8'));

	values.IDENTITY_NAME = options['identity-name'] || 'hyperlooptest.' + name;

	// Copy the current build's options in to the config.
	config.options = options;
	options.config = config;

	// remember these for later in the build
	options.jscDir = jscDir;
	options.srcDir = srcDir;
	options.solutionFile = solutionFile;
	options.projectFile = projectFile;
	options.appDir = appDir;

	var count = 0;
	function initPfx() {
		// if after 3 tries we can't create a valid cert, give up
		if (count++ >= 3) {
			log.fatal('Unable to create a valid test certificate.');
		}

		// get potential cert paths
		pfxPath = path.join(appDir, name+'_Key.pfx');
		var globalTestPfxPath = path.join(homeDir, 'DevelopmentKey.pfx');

		// do we have a valid test cert in the build folder
		if (fs.existsSync(pfxPath) && fs.statSync(pfxPath).size > 0) {
			log.debug('using',globalTestPfxPath);
			options.pfxPath = pfxPath;
			return proceed(solutionFile);
		}

		// if we have a valid global test cert, copy it in to the build folder
		else if (fs.existsSync(globalTestPfxPath) && fs.statSync(globalTestPfxPath).size > 0) {
			log.info('Using test certificate at ' + globalTestPfxPath.yellow + '!');
			options.pfxPath = pfxPath;
			util.copyFileSync(globalTestPfxPath, pfxPath);
			return proceed(solutionFile);
		}

		// if there's no valid test cert, create one
		else {

			// remove old/corrupt certs
			if (fs.existsSync(pfxPath)) { fs.unlinkSync(pfxPath); }
			if (fs.existsSync(globalTestPfxPath)) { fs.unlinkSync(globalTestPfxPath); }

			// create a cert
			log.info('Creating a temporary certificate for you.');
			log.info('If asked for a password, please hit "None" (do not specify a password).');
			programs.makecert('/r /h 0 /eku "1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.10.3.13" /e "10/01/2014" /sv "' + pvkPath + '" "' + cerFile + '"', function madeCert(err) {
				if (err && err.code !== 'OK') {
					log.error('Failed to makecert for you: makecert.exe failed.');
					log.fatal(err);
				}

				// convert the cert
				log.info('Converting the certificate for app signing...');
				programs.pvk2pfx('/pvk "' + pvkPath + '" /spc "' + cerFile + '" /pfx "' + pfxPath + '"', function madePfx(err) {
					if (err && err.code !== 'OK') {
						log.error('Failed to generate a test certificate for you: pvk2pfx.exe failed.');
						log.fatal(err);
					}
					log.info('Certificate created at ' + pfxPath.yellow + '!');
					fs.createReadStream(pfxPath).pipe(fs.createWriteStream(globalTestPfxPath));

					// run this function again to assert the cert creation succeeded
					return initPfx();
				});
			});
		}
	}

	// Check if we have a PFX file.
	if (!options.pfx) {
		return initPfx();
	}
	else if (!fs.existsSync(options.pfx)) {
		log.fatal("No pfx file exists at " + options.pfx.yellow + ". " + "Hint: Omit --pfx if you want to use a test certificate.".green);
	}
	else {
		if (!fs.existsSync(pfxPath)) {
			// Copy the PFX in to the project.
			fs.createReadStream(options.pfx).pipe(fs.createWriteStream(pfxPath));
		}
		return proceed(solutionFile);
	}
}

function generateGuid(options) {
	var name = options.name,
		appDir = path.join(options.dest,'vsstudio',name),
		guidPath = path.join(appDir,'guid'),
		hasGuid = (fs.existsSync(guidPath) && fs.readFileSync(guidPath, 'utf8')),
		guid = hasGuid || util.guid();

	options.appguid = guid;
	options.guidPath = guidPath;

	!hasGuid && fs.writeFileSync(options.guidPath, options.appguid, 'utf8');
}

function pkg(options, callback) {
	generateCerts(options, function(solutionFile){
		generateGuid(options);
		//TODO: hard coded to win32 for now
		programs.msbuild(solutionFile+' /p:Platform=Win32', callback, options);
	});
}
