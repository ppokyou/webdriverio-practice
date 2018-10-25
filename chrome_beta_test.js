var webdriverio = require('webdriverio');
var options = {
	desiredCapabilities: {
		browserName: 'chrome',
		chromeOptions: {
			args: ['user-data-dir=C:\\TCSysTest\\ChromeProfiles\\TCChromeUserData',
				'load-extension=C:\\TCSysTest\\TCChrome\\Extension'
			],
			binary: 'C:\\TCSysTest\\Chromium\\chrome.exe'
		}
	}
};
var client = webdriverio.remote(options);
console.log('----launching TC Lite------');
client
	.init()
	.url('https://duckduckgo.com/')
	.setValue('#search_form_input_homepage', 'WebdriverIO')
	.click('#search_button_homepage')
	.getTitle().then(function (title) {
		console.log('Title is: ' + title);
		// outputs: "Title is: WebdriverIO (Software) at DuckDuckGo"
	})
	.end();
console.log('-----------------');