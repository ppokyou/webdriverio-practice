// (c) Copyright 1994-2018 EntIT Software LLC
(function() {

	"use strict";

	var taskHungThreshhold = 200;  //task step not update state for 120 seconds, will be regarded as hung

	var fs = require('fs');
	var XML = require('xml');
	var path = require('path');
	var http = require('http');
	var app = require('express')();
	var server = http.createServer(app);
	var io = require('socket.io').listen(server,{ log: false });
	var execFile = require('child_process').execFile;
	var spawn = require('child_process').spawn;
	var config = require('./systest_config');

	var lastPid = 0;
	var profileCount = 0;

	var clientList = {}; // sockets
	var pendingTaskList = {}; // Tasks waiting to be excuted
	var activeTaskList = {}; // Tasks being excuted
	var finishedTaskList = {}; // Tasks that have finished excution
	var CommunicationLostTaskList = {}; //tasks that browser doesn't report status to server
	var lastSession = {};

	var failedFinishedTests = 0;
	var baseDir = config.baseDir;
	var serverDir = baseDir + "Server\\";
	var scriptsBaseDir = baseDir + "Scripts\\";
	var resultsDir = baseDir + "Results\\";
	var interactiveLogsDir = baseDir + "InteractiveLogs\\";
	var _covFile = resultsDir + "CodeCoverageReport\\SysTest.cov";
	var _confFile = baseDir + "Configurations.json";
	var testSuiteName = undefined;

	var maxAllowedBrowserExceptions = 9;
	var browserExceptions = 0;

	if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);
	if (!fs.existsSync(interactiveLogsDir)) fs.mkdir(interactiveLogsDir);

	function getTimeStr() {
		var date = new Date();
		return date.toJSON();
	}
	function getClientsStatus() {
		var clientsStatus = [];
		Object.getOwnPropertyNames(clientList).forEach(
			function (propName) {
				if (propName !== "" && clientList[propName].length !== undefined) {
					clientsStatus.push("There are ", clientList[propName].length, " active browsers of type ", propName, ":\r\n");
					for (var i = 0; i < clientList[propName].length; i++) {
						clientsStatus.push('\t ', i, ": status = ", clientList[propName][i].tcstatus,
							', id = ', clientList[propName][i].socket.id, ', pid = ', clientList[propName][i].pid,
							', taskId = ', clientList[propName][i].taskId, "\r\n");
					}
				}
			}
		);

		return clientsStatus.join('');
	}

	function KillBrowsers() {
		for (var browserType in clientList) {
			clientList[browserType].emit('killTC');
		}
		console.log(Date() + "  " + "All browsers are going down");
	}

	function getReadyBrowser(browserType) {
		function getSessionInArr(start, end) {
			for (var i = start; i <= end; i++) {
				if (sessionArr[i].tcstatus === 'ready') {
					sessionArr[i].tcstatus = 'busy';
					console.log(Date() + "  " + 'getSession returnning session number :' + i + " for browser type " + browserType + ", id : " + sessionArr[i].socket.id);
					lastSession[browserType] = i;
					return sessionArr[i];
				}
			}
		}

		var sessionArr = clientList[browserType];

		if (lastSession[browserType] === undefined)
			lastSession[browserType] = 0;

		var newSession = getSessionInArr(lastSession[browserType], sessionArr.length - 1);
		if (newSession === undefined) {
			var endIndex = lastSession[browserType];
			if (endIndex >= sessionArr.length)
				endIndex = sessionArr.length - 1;
			newSession = getSessionInArr(0, endIndex);
		}

		if (newSession !== undefined)
			return newSession;

		lastSession[browserType] = 0;
		return null;
	}

	function freeBrowser(browser) {
		browser.tcstatus = 'ready'
	}

	function addBrowserTaskResult(taskList, browserType, xmlroot, defaultResult) {
		// xmlobj = [
		//	{sanity : [
		//		{ _attr: { name: 'TruClient'} },
		//		{TestSuite : [{ _attr: { name: 'SysTest_FF_Interactive'} },
		//			{Test : [ { _attr: { name: 'qfly.xml', type = 'replayOnly' } },
		//				[{result: Pass}, {exception:""}]]}
		//		]}
		//	]} ];

		var xmlobjBrowser = null;
		var xmlobjTask = null;
		var xmlobjResult = null;
		var xmlobjException = null;
		var xmlObjLog = null;

		var length = taskList.length;
		var i = 0;
		var taskType = '';
		var task = null;
		var prefix = '';

		// find it in xmlroot
		var suiteCount = xmlroot.length;
		var j = 1;
		for (; j < suiteCount; ++j) {
			if (xmlroot[j].TestSuite[0]._attr.name === browserType) {
				xmlobjBrowser = xmlroot[j];
				break;
			}
		}

		if (xmlobjBrowser === null) {
			xmlobjBrowser = new Object;
			xmlobjBrowser['TestSuite'] = [{_attr: {name: browserType}}];
			xmlroot.push(xmlobjBrowser);
		}

		for (; i < length; ++i) {
			// The scripts(tasks) are already sorted by task type.
			task = taskList[i];

			xmlobjTask = new Object;
			xmlobjTask['Test'] = [{_attr: {name: task.props.scriptName, type: task.taskType}}];

			// result
			xmlobjResult = new Object;

			if (task.result) {
				switch (task.result.color) {
					case 'green':
						xmlobjResult['result'] = 'Pass';
						break;
					case 'yellow':
						xmlobjResult['result'] = 'Warning';
						break;
					case 'red':
					default:
						xmlobjResult['result'] = 'Fail';
						break;
				}
			}
			else {
				xmlobjResult['result'] = defaultResult || 'Fail';
			}

			var exceptionText = "";
			xmlobjException = new Object;
			xmlobjException['exception'] = "";
			if (task.result && task.result.color == "red" && task.result.errors) {
				if (task.result.errors[0].stage)
					prefix = '[' + task.result.errors[0].stage + ']';
				else
					prefix = '';
				exceptionText = prefix.concat(task.result.errors[0].error);

				var prevTest = task.result.errors[0].error;
				for (var errorLog = 1; errorLog < task.result.errors.length; ++errorLog) {

					// exception
					if (task.result.errors[errorLog].error != prevTest) {
						exceptionText += task.result.errors[errorLog].error;
						prevTest = task.result.errors[errorLog].error;
					}
				}
			}

			xmlobjException['exception'] = exceptionText;
			xmlobjTask['Test'].push(xmlobjResult);
			xmlobjTask['Test'].push(xmlobjException);

			xmlObjLog = new Object;
			var logText = "";
			if (task.result && task.result.color == "red") {
				logText = task.result.logText || "";
			}
			xmlObjLog["log"] = logText;
			xmlobjTask['Test'].push(xmlObjLog);

			xmlobjBrowser['TestSuite'].push(xmlobjTask);
		}
	}

	function addJunitBrowserTaskResult(taskList, browserType, xmlroot, testsuite, defaultResult) {
		var xmlobjBrowser = null;
		var xmlobjTask = null;
		var xmlobjResult = null;
		var xmlobjException = null;

		var length = taskList.length;
		var i = 0;
		var task = null;
		var prefix = '';

		// find it in xmlroot
		var suiteCount = xmlroot.length;
		var j = 1;
		for (; j < suiteCount; ++j) {
			if (xmlroot[j].testsuite[0]._attr.name === browserType) {
				xmlobjBrowser = xmlroot[j];
				break;
			}
		}

		if (xmlobjBrowser === null) {
			xmlobjBrowser = new Object;
			xmlroot.push(xmlobjBrowser);
			xmlobjBrowser['testsuite'] = [{_attr: {name: testsuite || browserType, errors: "0", tests: length, failures: "0", time: "00.00", timestamp: new Date()}}];
		}

		for (; i < length; ++i) {
			// The scripts(tasks) are already sorted by task type.
			task = taskList[i];

			xmlobjTask = new Object;
			xmlobjTask['testcase'] = [{_attr: {classname: "SysTest", name: task.props.scriptName, time: task.duration}}];

			// result
			xmlobjResult = new Object;

			if (task.result) {
				switch (task.result.color) {
					case 'green':
					case 'yellow':
						break;
					case 'red':
						if (task.result.errors) {
							if (task.result.errors[0].stage)
								prefix = '[' + task.result.errors[0].stage + ']';
							else
								prefix = '';
							xmlobjException = new Object;
							xmlobjException['failure'] = prefix.concat(task.result.errors[0].error);
							xmlobjTask['testcase'].push(xmlobjException);

						}
					default:
						failedFinishedTests++;
						break;
				}
			}
			xmlobjBrowser['testsuite'].push(xmlobjTask);
		}
		xmlobjBrowser['testsuite'][0]._attr.failures = failedFinishedTests;
	}

	function outputResultFile() {
		var xmlobj = [{sanity: [{_attr: {name: 'TruClient'}}]}];
		var prop = null;

		for (prop in finishedTaskList)
			addBrowserTaskResult(finishedTaskList[prop], prop, xmlobj[0].sanity, null);

		for (prop in activeTaskList)
			addBrowserTaskResult(activeTaskList[prop], prop, xmlobj[0].sanity, 'running');

		for (prop in pendingTaskList)
			addBrowserTaskResult(pendingTaskList[prop], prop, xmlobj[0].sanity, 'pending');

		fs.writeFileSync(resultsDir + 'sanityResults.xml', XML(xmlobj, true));
	}

	function getJUnitTestSuite() {
		if (_confFile) {
			try {
				var text = fs.readFileSync(_confFile).toString();
				if (text) {
					var json = JSON.parse(text);
					if (json) {
						if (json.ReportTitle) {
							return json.ReportTitle;
						}
					}
				}
			}
			catch (e) {
				//just reset the conf file name
			}
			_confFile = undefined;
			return undefined;
		}
	}

	function outputJUnitResultFile() {
		if (_confFile && !testSuiteName)
			testSuiteName = getJUnitTestSuite();

		failedFinishedTests = 0;
		var xmlobj = [{testsuites: []}];
		var prop = null;

		for (prop in finishedTaskList)
			addJunitBrowserTaskResult(finishedTaskList[prop], prop, xmlobj[0].testsuites, testSuiteName, null);

		fs.writeFileSync(resultsDir + 'sanityJUnitResults.xml', XML(xmlobj, true));
	}

	function getPendingTaskCount() {
		var count = 0;
		var i, arr, typeCount = browserTypes.length;

		for (i = 0; i < typeCount; ++i) {
			arr = pendingTaskList[browserTypes[i]];
			if (arr !== undefined) {
				count += arr.length;
			}
		}
		return count;
	}

	function getActiveTaskCount() {
		var count = 0;
		var i, arr, typeCount = browserTypes.length;

		for (i = 0; i < typeCount; ++i) {
			arr = activeTaskList[browserTypes[i]];
			if (arr !== undefined) {
				count += arr.length;
			}
		}
		return count;
	}

	function reportResult() {
		outputResultFile();
		outputJUnitResultFile();
		if (getPendingTaskCount() === 0 && getActiveTaskCount() === 0) {
			console.log("!!!!!!!!!!!!! Finished !!!!!!!!!!!!!");
			killSysTestProcesses(['iexplore.exe', 'tcwebielauncher.exe', 'chrome.exe', 'truclientbrowser.exe'], outputCodeCoverageReport, [exitServer, []]);
		}
	}

	function onTaskFinish(task, result) {
		var i, sessionArr, length, browserType = task.browserType;

		task.duration = (Date.now() - task.startTime) / 1000;
		task.result = result;
		console.log(Date() + "  " + "===replay result for script [" + task.taskId + ": " + task.props.scriptName + "] :" + task.result.color + "===");

		finishedTaskList[browserType] = finishedTaskList[browserType] || [];
		finishedTaskList[browserType].push(task);

		if (pendingTaskList[browserType].length === 0) {
			// If there is no task for this type of browser, we can just close the 'ready' ones.
			sessionArr = clientList[browserType];

			if (sessionArr !== undefined) {
				length = sessionArr.length;

				for (i = 0; i < length; ++i) {
					if (sessionArr[i].tcstatus === 'ready') {
						sessionArr[i].socket.emit('killTC', {});

						// Temporary Solution: launch next type of browser
						if (serverEnv.testSettings.clientLaunchMode === 'one-by-one')
							launchClients();
					}
				}
			}
		}

		reportResult();
	}

	function runNextTask(browserType) {
		if (!pendingTaskList[browserType]) {
			console.error("!!!! pendingTaskList[" + browserType + "] does not exists");
			return;
		}

		var task = pendingTaskList[browserType].pop();
		if (!task) {
			console.log(Date() + "  " + 'no more task for browser ' + browserType);
			return;
		}

		console.log(Date() + "Run next task, try to find a free browser of type " + browserType + ".");
		console.log(getClientsStatus());
		var browser = getReadyBrowser(browserType);
		if (browser === null) {
			console.log(Date() + "  " + "!!!! did not find a free browser of type " + browserType + " to handle the next task");
			pendingTaskList[browserType].push(task);
			var browserArray = clientList[browserType];
			if (browserArray && browserArray.length === 0) {
				launchClient(browserType);
			}
			return;
		}

		var socket = browser.socket;
		activeTaskList[browserType] = activeTaskList[browserType] || [];
		activeTaskList[browserType].push(task);

		console.log(Date() + "  " + "about to send task : [" + task.taskId + ": " + task.props.scriptName + "] to socket id=" + socket.id + " pid=" + browser.pid);

		socket.emit('task', task);
		browser.taskId = task.taskId;
		task.scriptSanityState = {event: "sever emit task", step: "send task to browser", time: getTimeStr()};
		task.startTime = Date.now();
	}

	function findClientByTaskId(browserType, taskId) {
		var j, sessionArr, sessionCount;
		sessionArr = clientList[browserType];

		if (sessionArr !== undefined) {
			sessionCount = sessionArr.length;
			console.log("============================");
			for (j = 0; j < sessionCount; ++j) {
				console.log("socket.id=" + sessionArr[j].socket.id + " pid=" + sessionArr[j].pid + " taskId=" + sessionArr[j].taskId);
			}
			console.log("^^^^^^^^^^^^^^^^^^^^^^^^");
			for (j = 0; j < sessionCount; ++j) {
				if (sessionArr[j].taskId === taskId)
					return sessionArr[j];
			}
		}

		return null;
	}

	function removeBrowserInstanceByPid(pid) {
		var typeCount = browserTypes.length;

		for (var i = 0; i < typeCount; ++i) {
			var clientInfo = clientInfoArray[browserTypes[i]];
			var idxInstance = clientInfo.instances.indexOf(pid);
			if (idxInstance !== -1) {
				clientInfo.instances.splice(idxInstance, 1);
				return true; // Instance is found
			}
		}

		return false; // Instance is not found
	}

	function findClientByPid(browserType, pid) {
		var j, sessionArr, sessionCount;
		sessionArr = clientList[browserType];

		if (sessionArr !== undefined) {
			sessionCount = sessionArr.length;
			for (j = 0; j < sessionCount; ++j) {
				if (sessionArr[j].pid === pid)
					return sessionArr[j];
			}
		}

		return null;
	}

	function buildTask(browserType, taskType, taskTypeDir, scriptName, taskId) {
		var scriptPath;
		var scriptContent;
		var resultsPath = resultsDir + browserType + "\\" + taskType + "\\" + scriptName;

		switch (browserType) {
			case "SysTest_FF_Interactive":
			case "SysTest_IE_Interactive":
			case "SysTest_Chrome":
			case "SysTest_TruClientBrowser":
			case "SysTest_NativeMobile":
				scriptPath = taskTypeDir.concat("\\", scriptName, "\\default.xml");
				break;
			case "SysTest_FF_LR_Interactive":
			case "SysTest_IE_LR_Interactive":
				scriptPath = taskTypeDir.concat("\\", scriptName, '\\default.zip');
				break;
			case "SysTest_ChromeLite":
				scriptPath = taskTypeDir.concat("\\", scriptName, '\\', scriptName, '.zip');
				scriptContent = new Buffer(fs.readFileSync(scriptPath)).toString('base64');
				break;
			case "SysTest_TruClientBrowserLite":
				scriptPath = taskTypeDir.concat("\\", scriptName, '\\', scriptName, '.zip');
				scriptContent = new Buffer(fs.readFileSync(scriptPath)).toString('base64');
				break;
			default:
				console.error("!!!! browserType '".concat(browserType, "' is not knowen in buildTask !!!!"));
		}

		return {
			'browserType': browserType,
			'taskId': taskId,
			'taskType': taskType,
			'props': {
				scriptPath: scriptPath,
				scriptName: scriptName,
				scriptContent: scriptContent,
				resultsPath: resultsPath,
				saveOnEnd: clientInfoArray[browserType].saveOnEnd
			}
		};
	}

	function preaprePendingTaskList() {
		var browserTypeScriptDirs = fs.readdirSync(scriptsBaseDir);
		var taskId = 0;

		// Go over all the browser types
		for (var browserScriptDir of browserTypeScriptDirs) {
			pendingTaskList[browserScriptDir] = [];
			var browserTypeDir = scriptsBaseDir + browserScriptDir;
			var taskTypeScriptDirs = fs.readdirSync(browserTypeDir); //replayScript and recordReplayScript

			// Go over all the event types
			for (var taskScriptDir of taskTypeScriptDirs) {
				var taskTypeDir = path.join(browserTypeDir, taskScriptDir);
				var scripts = fs.readdirSync(taskTypeDir);
				// Go over all the scripts
				for (var script of scripts) {
					var task = buildTask(browserScriptDir, taskScriptDir, taskTypeDir, script, taskId);
					taskId++;
					pendingTaskList[browserScriptDir].push(task);
				}
			}
		}

		return browserTypeScriptDirs.length;
	}

	function getBrowserPendingTaskCount(browserType) {
		if (!pendingTaskList[browserType]) return 0;

		return pendingTaskList[browserType].length;
	}

	function handleHungTask(task) {
		console.log(Date() + "  " + "task hung!!!");
		console.log(task);

		var browser = findClientByTaskId(task.browserType, task.taskId);
		if (browser !== null) {
			// kill browser, socket will be closed automatically
			console.log(Date() + "  " + "!!! Task hung, Kill process socket id = " + browser.socket.id + " process id = " + browser.pid);
			try {
				process.kill(browser.pid);
			}
			catch (ex) {
				console.log("kill exception: " + ex);
			}
			// This browser instance is no longer valid for task run, remove it right away
			removeBrowserInstanceByPid(browser.pid);

			// If launchClients returns
			// - 'ok', it means a browser is successfully launched and server will keep launching browsers until the requirement is met.
			// - 'end', no more browser is required.
			// - 'busy' server is already in a launching loop, no need to start another loop.
			launchClients();
		}

	}

	function checkHungTasks() {
		var browserType = null, task = null, list = null;
		var taskLastUpdateTime;
		var CurrentTime = (new Date()).getTime();
		var timeDiff = 0;

		for (browserType in activeTaskList) {
			//console.log("in checkHungTasks, browserType=" + browserType);
			list = activeTaskList[browserType];

			//console.log("active task list=", length);
			for (var length = list.length, i = length - 1; i >= 0; --i) {
				task = list[i];
				//console.log(task.scriptSanityState);
				if (task.scriptSanityState) {
					taskLastUpdateTime = Date.parse(task.scriptSanityState.time);
					timeDiff = (CurrentTime - taskLastUpdateTime) / 1000;
					if (timeDiff > taskHungThreshhold) {
						console.log(Date() + "  " + "hung time = " + timeDiff + " seconds");
						handleHungTask(task);

						activeTaskList[browserType].splice(i, 1);
						var bTaskHasLostOnce = false;
						if (CommunicationLostTaskList[browserType]) {
							var lostLength = CommunicationLostTaskList[browserType].length;
							for (var j = 0; j < lostLength; j++) {
								if (task.props.scriptName == CommunicationLostTaskList[browserType][j]) {
									bTaskHasLostOnce = true;
									break;
								}
							}
						}
						console.log(task.props.scriptName + " lost once " + bTaskHasLostOnce);
						if (bTaskHasLostOnce) {
							removeTaskFromList(activeTaskList[browserType], task.taskId);
							finishedTaskList[browserType] = finishedTaskList[browserType] || [];
							finishedTaskList[browserType].push(task);

							task.result = {};
							var taskError = {error: "step hung : " + task.scriptSanityState.step};
							task.result.color = "red";
							task.result.errors = [];
							task.result.errors.push(taskError);

							console.log("===replay result for script [" + task.props.scriptName + "] :" + task.result.color + "===");
							reportResult();
						} else {
							CommunicationLostTaskList[browserType] = CommunicationLostTaskList[browserType] || [];
							CommunicationLostTaskList[browserType].push(task.props.scriptName);
							removeTaskFromList(activeTaskList[browserType], task.taskId);
							task.taskId += 10000;
							pendingTaskList[browserType].push(task);
							runNextTask(browserType);
							console.log("===replay result for script [" + task.props.scriptName + "] :" + " yellow   browser hung, retry to replay the script ===");
						}
					}
				}
			}
		}
		setTimeout(checkHungTasks, 60000);
	}

	setTimeout(checkHungTasks, 60000);

	function copyFileSync(source, destination) {
		var sourceStats, data;

		sourceStats = fs.statSync(source);

		if (!fs.existsSync(source) ||
			fs.existsSync(destination) ||
			!sourceStats.isFile()) {
			console.log(Date() + "  " + 'copyFileSync failed because source file does not exist, or destination file alerady exists, or source is not a file.');
			return false;
		}

		data = fs.readFileSync(source);
		fs.writeFileSync(destination, data, {encoding: null});

		return true;
	}

	function deleteFolderRecursive(folderPath) {
		if (fs.existsSync(folderPath)) {
			fs.readdirSync(folderPath).forEach(function (file, index) {
				var curPath = folderPath + "/" + file;
				if (fs.lstatSync(curPath).isDirectory()) { // recurse
					deleteFolderRecursive(curPath);
				} else { // delete file
					fs.unlinkSync(curPath);
				}
			});
			fs.rmdirSync(folderPath);
		}
	}

	function copyFolderSync(source, destination) {
		var sourceStats, dirArr, dirCount, i, itemStats;

		sourceStats = fs.statSync(source);
		if (!fs.existsSync(source) || !sourceStats.isDirectory()) {
			console.log(Date() + "  " + 'copyFolderSync failed because source folder ' + source + ' does not exist, or destination folder ' + destination + ' already exists, or source is not a folder.');
			return false;
		}

		deleteFolderRecursive(destination);

		// remove slash/back slash at the end
		if (source.charAt(source.length - 1) === path.sep)
			source = source.substr(0, source.length - 1);
		if (destination.charAt(destination.length - 1) === path.sep)
			destination = destination.substr(0, destination.length - 1);

		fs.mkdirSync(destination);
		dirArr = fs.readdirSync(source);
		dirCount = dirArr.length;
		for (i = 0; i < dirCount; ++i) {
			if (dirArr[i] === '.' || dirArr[i] === '..')
				continue;
			itemStats = fs.statSync(source.concat(path.sep, dirArr[i]));
			if (itemStats.isDirectory()) {
				if (!copyFolderSync(source.concat(path.sep, dirArr[i]), destination.concat(path.sep, dirArr[i]))) {
					console.log('failed to copy ' + source.concat(path.sep, dirArr[i]) + ' to ' + destination.concat(path.sep, dirArr[i]));
				}
			}
			else {
				if (!copyFileSync(source.concat(path.sep, dirArr[i]), destination.concat(path.sep, dirArr[i]))) {
					console.log('failed to copy ' + source.concat(path.sep, dirArr[i]) + ' to ' + destination.concat(path.sep, dirArr[i]));
				}
			}
		}

		return true;
	}

	function calculateRequirements() {
		var i, count, browserType, typeCount = browserTypes.length;
		for (i = 0; i < typeCount; ++i) {
			browserType = browserTypes[i];
			if (pendingTaskList[browserType] !== undefined) {
				count = pendingTaskList[browserType].length;

				if (activeTaskList[browserType] !== undefined) {
					count += activeTaskList[browserType].length;
				}

				clientInfoArray[browserType].requiredBrowser = Math.min(count, clientInfoArray[browserType].maxInstance);
			}
		}
	}

	function onExceptionCheck(browserType, pid, error) {
		var browser = findClientByPid(browserType, pid);
		var list = pendingTaskList[browserType];
		var task, e;
		if (!browser)
			console.log(Date() + "  " + "In onExceptionCheck pid=" + pid + " socket=null error=" + JSON.stringify(error));
		else if (error.code !== 'TC_CONNECTION_TIMEOUT')
			console.log(Date() + "  " + "In onExceptionCheck pid=" + pid + " socket.id=" + browser.socket.id + " error=" + JSON.stringify(error));
		// fail to connect (crash / hung / communication error / etc...)
		// - socket === null means client failed to connect or disconnected.
		// - list.length > 0 means client should not disconnect
		// so the combination of these two conditions means fail to connect.
		// The heartbeat interval (25s by default, https://github.com/LearnBoost/Socket.IO/wiki/Configuring-Socket.IO)
		// somehow guarantees this callback to be called before socket.on('disconnect').
		if (browser === null && list.length > 0) {
			// kill it no matter if it's already exited.
			try {
				browserExceptions += 1;
				console.log(Date() + "  " + '!!! client failed to connect kill pid = ' + pid + " error = " + error + " browserExceptions = " + browserExceptions);
				process.kill(pid);
			}
			catch (e) {
				//console.log('kill exception=' + e);
			}
			if (browserExceptions > maxAllowedBrowserExceptions) {
				// should fail all pending tasks for this kind of browser
				for (task = list.pop(); task !== undefined; task = list.pop()) {
					onTaskFinish(task, {color: 'red', errors: [{error: 'failed to launch the browser, code:' + error.code}]});
				}
			}

			// set lastPid to 0, so that another browser can be launched
			// because there will be no connection event in which we set the lastPid to 0.
			lastPid = 0;

			launchClients();
		}
		// We may reach here after connection(socket!==null), so we have to check the error code to make sure it's a crash, not a psudo 'timeout'.
		else if (browser && error.code !== 'TC_CONNECTION_TIMEOUT') {
			// if the browser exit with exception, remove task from active task list
			list = activeTaskList[browserType];
			task = removeTaskFromList(list, socket.taskId);
			if (task !== null)
				onTaskFinish(task, {color: 'red', errors: [{error: 'exit with exception at step:' + task.scriptSanityState.step}]});
			launchClients();
		}
	}

	function launchClient(browserType) {
		var child, param, clientInfo = clientInfoArray[browserType];

		if (lastPid !== 0) {
			console.log(Date() + "  " + "another browser is launching, stop launch client, launch pid=" + lastPid);
			return 'busy';
		}

		// To Refactor: a temp urgly implementation for FF profile
		param = clientInfo.param.slice();

		if (browserType === 'SysTest_NativeMobile') {
			profileCount++;
			//Folder "TCNMClonedProfiles" is being create using CreateSysTestTCNM.bat
			param[2] = baseDir.concat('TCNMClonedProfiles\\SysTestProfile', profileCount);
			copyFolderSync(baseDir.concat('TCNMProfiles\\SysTestProfileTemplate'), param[2]);
		}
		else if (browserType === 'SysTest_FF_Interactive') {
			profileCount++;
			//Folder "TCBClonedProfiles" is being create using CreateSysTestFF.bat
			param[2] = baseDir.concat('TCBClonedProfiles\\SysTestProfile', profileCount);
			copyFolderSync(baseDir.concat('TCBProfiles\\SysTestProfileTemplate'), param[2]);
		}
		else if (browserType == 'SysTest_Chrome') {
			profileCount++;
			var profilePath = baseDir.concat('ChromeProfiles\\TCChromeUserData', profileCount);
			copyFolderSync(baseDir.concat('ChromeProfiles\\TCChromeUserData'), profilePath);
			param.push('--user-data-dir=' + profilePath);
			param.push("http://0.0.0.0/tc_home.html?-ExtensionRoot=C:\\TCSysTest\\TCChrome\\Extension&-TC_ADDIN=SysTest_Chrome&-ext_server_http_port=3003&-ext_server_https_port=3004")
			param.push("--load-extension=" + baseDir +"TCChrome\\Extension");
		}
		else if (browserType == 'SysTest_ChromeLite') {
			profileCount++;
			var profilePath = baseDir.concat('ChromeProfiles\\TCChromeUserData', profileCount);
			copyFolderSync(baseDir.concat('ChromeProfiles\\TCChromeUserData'), profilePath);
			param.push('--user-data-dir=' + profilePath);
			//param.push("http://0.0.0.0/tc_home.html?-TC_ADDIN=SysTest_ChromeLite")
			param.push("--load-extension=" + baseDir +"TCChromeLite\\Extension");
		}
		else if (browserType == 'SysTest_TruClientBrowser') {
			profileCount++;
			var profilePath = baseDir.concat('TruClientBrowserProfiles\\WebTruClientBrowserUserData', profileCount);
			copyFolderSync(baseDir.concat('TruClientBrowserProfiles\\WebTruClientBrowserUserData'), profilePath);
			param.push('-profile');
			param.push(profilePath);
			param.push("about:blank?-ExtensionRoot=C:\\TCSysTest\\TruClientBrowser\\extensions\\TruClientBrowser@hpe.com&-TC_ADDIN=SysTest_TruClientBrowser&-ext_server_http_port=3003&-ext_server_https_port=3004");
		}
		else if (browserType == 'SysTest_TruClientBrowserLite') {
			profileCount++;
			var profilePath = baseDir.concat('TruClientBrowserProfiles\\WebTruClientBrowserUserData', profileCount);
			copyFolderSync(baseDir.concat('TruClientBrowserProfiles\\WebTruClientBrowserUserData'), profilePath);
			param.push('-profile');
			param.push(profilePath);
		}

		//Other browsers will use the original info as defined in clientInfoArray.

		child = execFile(clientInfo.path, param, {}, function execCallback(error, stdout, stderr) {});
		child.browserType = browserType;
		clientInfo.instances.push(child.pid);
		lastPid = child.pid;
		console.log("client browser is launched, lastPid=" + lastPid);

		child.on('exit', function (code) {
			console.log(Date() + "  " + "process id =" + this.pid + " exiting");
			removeBrowserInstanceByPid(child.pid);
			if (!clientInfo.monitorProc)
				return;
			if (!clientList) {
				return;
			}
			var browserArray = clientList[this.browserType] || [];
			for (var i = 0; i < browserArray.length; i++) {
				if (browserArray[i].pid === this.pid) {
					console.log(Date() + "  " + "*** Removed client of type " + this.browserType + " (number " + i + ", pid " + this.pid + ") ***");
					browserArray.splice(i, 1);
					if (browserArray.length === 0 && pendingTaskList[browserType].length > 0) {
						launchClient(browserType);
					}
					return;
				}
			}
		});

		console.log(Date() + "  " + 'launched Client pid: '.concat(child.pid));
		if (clientInfo.monitorProc)
			setTimeout(onExceptionCheck, 40000, browserType, child.pid, {code: 'TC_CONNECTION_TIMEOUT'});

		return 'ok';
	}

	function launchClients() {
		var i, clientInfo, typeCount = browserTypes.length;

		// always calculate because the number of pending tasks is decreasing
		calculateRequirements();

		for (i = 0; i < typeCount; ++i) {
			clientInfo = clientInfoArray[browserTypes[i]];

			// for the browsers fail to connect, all operations will be skipped automatically,
			// since the pending tasks are moved to finished list
			if (clientInfo.instances.length < clientInfo.requiredBrowser) {
				console.log(Date() + "  " + "start to launch client browserTypes=" + browserTypes[i]);
				return launchClient(browserTypes[i]);
			}
		}
		return 'end'; // no more browsers required
	}

	function removeTaskFromList(list, taskId) {
		var task = null;
		var length = 0, i = 0;
		var found = false;

		if (list === null || list === undefined)
			return null;

		length = list.length;

		for (i = 0; i < length; ++i) {
			task = list[i];

			if (task.taskId === taskId) {
				list.splice(i, 1);
				return task;
			}
		}

		return null;
	}

	function exitServer() {
		process.exit(0);
	}

	function outputCodeCoverageReport(callback, callbackArgs) {
		var exePath = config.bullsEyeExePath;
		var reportDir = path.join(baseDir, 'Results/CodeCoverageReport/');

		if (!fs.existsSync(exePath)) {
			console.log(exePath.concat(' does not exist!'));
			if (callback)
				callback.apply({}, callbackArgs);
			return;
		}

		if (!fs.existsSync(_covFile)) {
			console.log(_covFile.concat(' does not exist!'));
			if (callback)
				callback.apply({}, callbackArgs);
			return;
		}

		execFile(exePath, ['--file', _covFile, reportDir], function() {
			if (callback)
				callback.apply({}, callbackArgs);
		});
	}

	function killSysTestProcesses(killList, callback, callbackArgs) {
		setTimeout(killSysTestProcessesCore, 1000);

		function killSysTestProcessesCore() {
			var exec = require('child_process').exec, child;
			var listLength = killList.length;

			child = exec('tasklist', function (error, stdout, stderr) {
				var lines = stdout.split('\r\n');
				var i, j, processName, processId, line, count = lines.length;

				// first 3 lines are table header
				for (i = 3; i < count; ++i) {
					line = lines[i].split(/\s+/, 2);
					if (line.length === 2) {
						processName = line[0].toLowerCase();
						for (j = 0; j < listLength; ++j) {
							if (processName === killList[j]) {
								processId = parseInt(line[1]);
								try {
									process.kill(processId);
								} catch (err) {
									console.log(Date() + "  " + "******" + err);
								}
								console.log(Date() + "  " + 'kill pid:'.concat(line[1], ' ', line[0]));
								break;
							}
						}
					}
				}
				if (codedServerProc)
					process.kill(codedServerProc.pid);
				if (extServerProc)
					process.kill(extServerProc.pid);
				if (callback)
					callback.apply({}, callbackArgs);
			});
		}
	}

// We need to open a page before the replay for chrome, so host a blank page instead
// of opening an external page which may not be available
	function hostBlankPage() {
		app.get('/blank.html', function (req, res) {
			res.send('');
		});
	}

// Accepts connection from the browser (NodeJsCore.js)
	io.sockets.on('connection', function (socket) {
		var browser = {};
		browser.socket = socket;
		browser.pid = lastPid;
		lastPid = 0;
		// when the client emits addclient this listen and executes
		socket.on('addclient', function (data) {
			browser.tcstatus = 'ready';
			browserType = data.type;
			browser.browserType = browserType;
			browserArray = clientList[browserType] = clientList[browserType] || [];

			if (data.pid !== undefined) {
				browser.pid = data.pid;
			}

			for (var i = 0; i < browserArray.length; i++) {
				if (browserArray[i].pid === browser.pid) {
					//the socket is a reconection socket for the same browser instance, just update
					console.log(Date() + "  " + "***The same browser process id has been existing, it maybe a socket reconnection happens for process -  " + browser.pid + " ***");
					browserArray[i].socket = socket;
					browser = browserArray[i];
					return;
				}
			}

			originalClientId = browserArray.length;
			browserArray[originalClientId] = browser;
			console.log(Date() + "  " + 'socket ' + socket.id + ' pid=' + browser.pid + ' connected');

			console.log(Date() + "  " + "*** Added client of type " + browserType + " (number " + originalClientId + ") ***");

			// Check pending tasks for this browser
			if (getBrowserPendingTaskCount(browserType) === 0) {
				socket.emit('killTC', {});
				return;
			}

			// Get to work, you lazy ...
			runNextTask(browserType);
		});

		// when the user disconnects
		socket.on('disconnect', function () {
			console.log(Date() + "  " + "*** on socket disconnect, socket id = " + socket.id);
			//remove socket from clientList
			if (!browserArray) {
				console.log(Date() + "  " + "*** the socket didn't send add client message to server. socket id = " + socket.id);
				return;
			}
			for (var i = 0; i < browserArray.length; i++) {
				if (browserArray[i].socket.id === socket.id) {
					// Check if there is any task running on this socket
					if (browserArray[i].tcstatus === 'busy') {
						console.log(Date() + " !!!! Warning -- Socket disconnected while there is task running on it. task id = " + browserArray[i].taskId);
					}
					console.log(Date() + "  " + "*** Removed client of type " + browserType + " (number " + i + ", original number " + originalClientId + ") ***");
					// Socket will be removed when browser process exits
					browserArray.splice(i, 1);
					if (browserArray.length === 0 && pendingTaskList[browserType].length > 0) {
						launchClient(browserType);
					}
					return;
				}
			}

			console.log(Date() + "  " + "!!!! Warning --  Did not find the client to disconect!!!!");
		});

		socket.on('taskEnd', function (data) {
			var taskList = activeTaskList[browserType];
			var task = removeTaskFromList(taskList, browser.taskId);

			if (task === null) return;

			// mark the client as ready
			freeBrowser(browser);

			if (serverEnv.testSettings.clientLaunchMode === 'one-by-one') {
				// kill mdrv before assign another task
				killSysTestProcesses(['mdrv.exe'], function () {
					onTaskFinish(task, JSON.parse(data.result));
					runNextTask(browserType);
				});
			}
			else {
				try {
					// take another task
					onTaskFinish(task, JSON.parse(data.result));
					runNextTask(browserType);
				} catch (e) {
					console.error('Complete task with error ', task, e);
					runNextTask(browserType);
				}
			}
		});

		socket.on('stateupdate', function (data) {
			var _browserType = null;

			for (_browserType in activeTaskList) {
				var taskList = activeTaskList[_browserType];
				for (var task of taskList) {
					if (task.taskId === data.taskId) {
						task.scriptSanityState = data.result;
						return;
					}
				}
			}
		});

		var browserArray;
		var type;
		var originalClientId;
		var browserType;

		if (serverEnv.testSettings.clientLaunchMode !== 'one-by-one') {
			launchClients();
		}
	});

	var serverEnv = {"testSettings": {"maxClients": {"FireFox4TCNM": 1, "FireFox": 10, "IE": 10, "Chrome": 10, "FirefoxLite": 1, "TruClientBrowser": 10}, "clientLaunchMode": ''}}; // default environment

	if (fs.existsSync(path.join(serverDir, '/cfg/TCSanityCfg.json'))) {
		var cfgStr = fs.readFileSync(path.join(serverDir, '/cfg/TCSanityCfg.json'));
		serverEnv = JSON.parse(cfgStr);
	}

// The structure of the below arrays is [BrowserType][sesions\tests for that browser type]
// browser tyeps can be SysTest_NativeMobile, SysTest_FF_Interactive, SysTest_FF_LR_Interactive, SysTest_IE_LR_Interactive and so on...
	var browserTypes = ['SysTest_NativeMobile', 'SysTest_FF_Interactive', 'SysTest_IE_Interactive', 'SysTest_FF_LR_Interactive', 'SysTest_IE_LR_Interactive', 'SysTest_Chrome', 'SysTest_ChromeLite', 'SysTest_TruClientBrowserLite', 'SysTest_TruClientBrowser'];

	var clientInfoArray = {
		'SysTest_NativeMobile':
			{
				path: config.truclientBrowser50Path,
				param: ['-no-remote', '-profile', baseDir + 'TCNMProfiles\\SysTestProfile', '-addin', 'SysTest_NativeMobile'],
				maxInstance: serverEnv.testSettings.maxClients.FireFox4TCNM,
				monitorProc: true,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_FF_Interactive':
			{
				path: config.truclientBrowser50Path,
				param: ['-no-remote', '-profile', baseDir + 'TCBProfiles\\SysTestProfile', '-addin', 'SysTest_FF_Interactive'],
				maxInstance: serverEnv.testSettings.maxClients.FireFox,
				monitorProc: true,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_IE_Interactive':
			{
				path: config.tcWebIELauncherPath,
				param: ['-addin', 'SysTest_IE_Interactive'],
				maxInstance: serverEnv.testSettings.maxClients.IE,
				monitorProc: true,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_FF_LR_Interactive':
			{
				path: process.env.LR_PATH + 'bin\\LrWeb2Launcher.exe',
				param: ['-addin', 'SysTest_FF_LR_Interactive'],
				maxInstance: serverEnv.testSettings.maxClients.FireFox,
				monitorProc: false,
				requiredBrowser: 0,
				instances: [],
				saveOnEnd: true // This will make the script to be saved so the mdrv.log can be extracted later
			},
		'SysTest_IE_LR_Interactive':
			{
				path: process.env.LR_PATH + 'bin\\TcWebIELauncher.exe',
				param: ['-addin', 'SysTest_IE_LR_Interactive'],
				maxInstance: serverEnv.testSettings.maxClients.IE,
				monitorProc: true,
				requiredBrowser: 0,
				instances: [],
				saveOnEnd: true // This will make the script to be saved so the mdrv.log can be extracted later
			},
		'SysTest_Chrome':
			{
				path: config.chromePath,
				param: ["--disable-web-security", "--disable-popup-blocking", "--ignore-certificate-errors", "--no-first-run", "--test-type", "--silent-debugger-extension-api"],
				maxInstance: serverEnv.testSettings.maxClients.Chrome,
				monitorProc: false,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_ChromeLite':
			{
				path: config.chromeBetaPath,
				param: ["--disable-web-security", "--disable-popup-blocking", "--ignore-certificate-errors", "--no-first-run", "--test-type", "--silent-debugger-extension-api"],
				maxInstance: serverEnv.testSettings.maxClients.Chrome,
				monitorProc: false,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_TruClientBrowser':
			{
				path: config.truclientBrowserPath,
				param: ['-no-remote'],
				maxInstance: serverEnv.testSettings.maxClients.TruClientBrowser,
				monitorProc: true,
				requiredBrowser: 0,
				instances: []
			},
		'SysTest_TruClientBrowserLite':
			{
				path: config.firefoxDevEditionPath,
				param: ['-no-remote'],
				maxInstance: serverEnv.testSettings.maxClients.FirefoxLite,
				monitorProc: false,
				requiredBrowser: 0,
				instances: []
			}
	};

	process.env['COVFILE'] = _covFile;
	if (!preaprePendingTaskList()) {
		console.error("No scripts to run!");
		process.exit(0);
	}

//do not run coded test for TC Lite
	var SysTestType = process.argv[2];
	if (SysTestType !== "SysTest4Lite") {
		//run coded server
		process.env['TC_CI_PATH'] = baseDir;
		process.env['TCCodedServerPort'] = "3002";
		var codedServerProc = spawn(config.nodeExePath, [config.codedServerPath], {
			stdio: "inherit"
		});

		//run ext server
		process.env['TC_CI_PATH'] = baseDir;
		process.env['TCExtServerHttpPort'] = "3003";
		process.env['TCExtServerHttpsPort'] = "3004";
		var extServerProc = spawn(config.nodeExePath, [config.nodeMainServerPath], {
			stdio: "ignore"
		});
	}

	server.listen(3001);

// Host a blank page for chrome
	hostBlankPage();

	console.log('** System Test Server is ready to roll **');

// Launch client process according to the task number
//  - if client terminates with exception, launch another
//  - if client fails to start, report error and clear pending task list

	// In favor of TCB 50.0 and old FF, add components folder to path.
	process.env.PATH = baseDir + "TCBProfiles\\RRE\\components;" + baseDir + "TCNMProfiles\\RRE\\components;" + process.env.PATH;
	launchClients();
})();
