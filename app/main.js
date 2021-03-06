var request = require('request');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var fs = require('fs');

if (process.argv.length < 3) { // first element in array is "node", second is path
	console.error("You need the following parameters: apiKey (configFileLocation)");
	process.exit(1);
}

startPeriodicGarbageCollection();

var configLocation = "./config.json";
if (process.argv.length >= 4) { // first element in array is "node", second is path
	configLocation = process.argv[3];
}
var config = JSON.parse(fs.readFileSync(configLocation, 'utf8'));
if (!config.apiBaseUrl) {
	config.apiBaseUrl ="https://www.la1tv.co.uk/api/v1";
}

var apiBaseUrl = config.apiBaseUrl;
var apiKey = process.argv[2];
var qualityIds = config.qualityIds;
var randomise = config.randomise;
var playlistIds = config.playlistIds || [];
if (typeof(config.playlistId) !== "undefined" && config.playlistId !== null) {
	playlistIds.unshift(config.playlistId);
}
var mediaItemIds = config.mediaItemIds || [];
var blacklistedIds = config.blacklistedIds || [];
var whitelistedStreamIds = config.whitelistedStreamIds || null;
var playLiveStreams = config.playLiveStreams !== false;

// array of {mediaItem, url, type}
// items at the front of the array are popped off and played
var queue = [];
var handle = null;
var playerProcessCloseCallback = null;

// the candidate that's currently playing/loading to play
var liveCandidate = null;
var liveCandidate = null;
var updatingPlayer = false;
var refillingQueue = false;

initialise();

function initialise() {
	killPlayer();
	apiRequest("permissions", function(data) {
		var permissions = data.data;
		if (!permissions.vodUris) {
			console.error("Do not have \"vodUris\" api permission.");
			process.exit(1);
		}
		else if (!permissions.streamUris && playlistId === null) {
			console.error("Do not have \"streamUris\" api permission.");
			process.exit(1);
		}
		console.log("Initialised!");
		if (playLiveStreams) {
			liveStreamCheck();
		}
		loadNextItem();
	});
}

function apiRequest(url, callback) {
	console.log("Making api request.", url);
	request({
		url: apiBaseUrl+"/"+url,
		headers: {
			"X-Api-Key": apiKey
		}
	}, function(error, response, body) {
		if (!error && response.statusCode == 200) {
			console.log("Api request completed.");
			callback(JSON.parse(body));
		}
		else if (!error && response.statusCode == 404) {
			console.log("Api request completed but a 404 was returned.");
			callback(null);
		}
		else {
			console.log("Error making request to api. Retrying shortly.");
			setTimeout(function() {
				apiRequest(url, callback);
			}, 5000);
		}
	});
}

function isStreamWhitelisted(liveStream) {
	return !whitelistedStreamIds || whitelistedStreamIds.indexOf(liveStream.liveStreamId) !== -1; 
}

// check if something's live, and if it is add it to the front of the queue and switch to it.
function liveStreamCheck() {
	console.log("Checking for live streams.");
	var requestUrl = "mediaItems?sortMode=SCHEDULED_PUBLISH_TIME&sortDirection=DESC&streamIncludeSetting=HAS_LIVE_STREAM&limit=10";
	apiRequest(requestUrl, function(data) {
		var mediaItems = data.data.mediaItems;
		var foundLiveMediaItem = false;
		var newCandidate = null;
		
		for(var i=0; i<mediaItems.length; i++) {
			var mediaItem = mediaItems[i];
			var candidate = createCandidateFromMediaItem(mediaItem, "stream");
			if (!candidate || !isStreamWhitelisted(candidate.mediaItem.liveStream)) {
				continue;
			}

			if (liveCandidate !== null && liveCandidate.type === "stream" && candidate.url === liveCandidate.url) {
				foundLiveMediaItem = true;
				break;
			}
			if (newCandidate === null) {
				newCandidate = candidate;
			}
		}
		if (!foundLiveMediaItem) {
			if (newCandidate !== null) {
				// queue the live stream
				console.log("Queueing live stream to play on next switch.");
				queue.unshift(newCandidate);
				loadNextItem();
			}
			else if (liveCandidate !== null && liveCandidate.type === "stream") {
				// stream has ended
				console.log("Live stream has ended so loading next item.");
				loadNextItem();
			}
		}
		
		setTimeout(liveStreamCheck, 5000);
	});
}

// populate the queue with items
function refillQueue(callback) {
	var requestUrls = [];
	if (playlistIds.length === 0 && mediaItemIds.length === 0) {
		// get most recent
		requestUrls.push("mediaItems?sortMode=SCHEDULED_PUBLISH_TIME&sortDirection=DESC&vodIncludeSetting=HAS_AVAILABLE_VOD&limit=25");
	}
	
	if (playlistIds.length > 0) {
		playlistIds.forEach(function(playlistId) {
			requestUrls.push("playlists/"+playlistId+"/mediaItems");
		});
	}

	// to contain all media items which are supported in form {mediaItem, chosenQualityId}
	var candidates = [];

	var promise = Promise.resolve();
	requestUrls.forEach(function(requestUrl) {
		promise = promise.then(function() {
			return new Promise(function(resolve) {
				apiRequest(requestUrl, function(data) {
					var mediaItems = [];
					if (data) {
						mediaItems = playlistIds.length > 0 ? data.data : data.data.mediaItems;
						for (var i=0; i<mediaItems.length; i++) {
							var mediaItem = mediaItems[i];
							var candidate = createCandidateFromMediaItem(mediaItem, "video");	
							if (candidate !== null) {
								candidates.push(candidate);
							}
						}
					}
					resolve();
				});
			})
		});
	});

	if (mediaItemIds) {
		mediaItemIds.forEach(function(mediaItemId) {
			promise = promise.then(function() {
				return new Promise(function(resolve) {
					apiRequest("mediaItems/"+mediaItemId, function(data) {
						if (data) {
							var candidate = createCandidateFromMediaItem(data.data.mediaItem, "video");
							if (candidate !== null) {
								candidates.push(candidate);
							}
						}
						resolve();
					});
				});
			});
		});
	}

	promise.then(function() {
		if (randomise) {
			shuffle(candidates);
		}
		queue = queue.concat(candidates);
		newMediaItemIds = [];
		if (callback) {
			callback();
		}
	});
}

function isMediaItemValid(mediaItem, type) {
	if (type !== "video" && type !== "stream") {
		throw "Invalid item type.";
	}
	return type === "video" ? mediaItem.vod !== null && mediaItem.vod.available : mediaItem.liveStream !== null && mediaItem.liveStream.state === "LIVE";
}

function isMediaItemAllowed(mediaItem) {
	return blacklistedIds.indexOf(mediaItem.id) === -1;
}

function createCandidateFromMediaItem(mediaItem, type) {
	if (type !== "video" && type !== "stream") {
		throw "Invalid item type.";
	}
	
	if (!isMediaItemValid(mediaItem, type)) {
		return null;
	}

	if (!isMediaItemAllowed(mediaItem)) {
		return null;
	}
	
	var mediaItemPart = type === "video" ? mediaItem.vod : mediaItem.liveStream;
	
	var availableQualityIds = [];
	for (var j=0; j<mediaItemPart.qualities.length; j++) {
		availableQualityIds.push(mediaItemPart.qualities[j].id);
	}
	var chosenUrl = null;
	for (var j=0; j<qualityIds.length && chosenUrl === null; j++) {
		var proposedQualityId = qualityIds[j];
		if (availableQualityIds.indexOf(proposedQualityId) !== -1) {
			// find the url for the mp4 encoded version
			for (var k=0; k<mediaItemPart.urlData.length && chosenUrl === null; k++) {
				var item = mediaItemPart.urlData[k];
				if (item.quality.id === proposedQualityId) {
					for(var j=0; j<item.urls.length; j++) {
						var urlInfo = item.urls[j];
						if (type === "video") {
							if (urlInfo.type === "video/mp4") {
								chosenUrl = urlInfo.url;
								break;
							}
						}
						else if (type === "stream") {
							if (urlInfo.type === "application/x-mpegURL") {
								chosenUrl = urlInfo.url;
								break;
							}
						}
					}
				}
			}
		}
	}
	if (chosenUrl === null) {
		// could not find an applicable url
		return null;
	}
	
	return {
		mediaItem: mediaItem,
		url: chosenUrl,
		type: type
	};
}



// get the next item off the queue and play it
function loadNextItem() {
	if (queue.length === 0) {
		// if there's something playing stop it.
		loadCandidate(null);
		
		if (refillingQueue) {
			// loadNextItem will be called when the queue is refilled
			return;
		}
		
		refillingQueue = true;
		refillQueue(function() {
			refillingQueue = false;
			if (queue.length === 0) {
				console.log("Couldn't find anything to add to the queue. Checking again shortly.");
				setTimeout(function() {
					if (liveCandidate === null) {
						loadNextItem();
					}
				}, 5000);
			}
			else if (liveCandidate === null) {
				// load the next item if there's still nothing playing
				// a live stream could have been added to the front.
				loadNextItem();
			}
		});
	}
	else {
		loadCandidate(queue.shift());
	}
}
	
// load and play the provided candidate.
// if the candidate is null playback will just be stopped.
function loadCandidate(candidate) {
	liveCandidate = candidate;
	updatePlayer();

	function updatePlayer() {
		if (updatingPlayer) {
			return;
		}
		updatingPlayer = true;
		
		console.log("Loading next item...");
		if (handle !== null) {
			// there is currently something playing.
			// kill it. This will then trigger the close calback when the process ends, and this
			// will then call the callback below, which will then move into updatePlayerPt2 function
			playerProcessCloseCallback = function() {
				updatePlayerPt2();
			};
			killPlayer();
		}
		else {
			updatePlayerPt2();
		}
		
		function updatePlayerPt2() {
			if (liveCandidate === null) {
				console.log("There is no item to load.");
				updatingPlayer = false;
				return;
			}
			
			var candidate = liveCandidate;
			// check this candidate is still available and valid
			var requestUrl = "mediaItems/"+candidate.mediaItem.id;
			apiRequest(requestUrl, function(data) {
				
				if (candidate !== liveCandidate) {
					// the candidate to play next has changed whilst the api request was taking place.
					// make the request again with the new candidate
					updatePlayerPt2();
				}
				else {
					updatingPlayer = false;
					console.log("Checking next item is still a valid option.");
					var mediaItem = null;
					if (data !== null) {
						mediaItem = data.data.mediaItem;
					}
					if (mediaItem === null || !isMediaItemValid(mediaItem, candidate.type)) {
						console.log("Item no longer valid.");
						loadNextItem();
					}
					else {
						console.log("Item valid.");
						playItem(candidate.url, candidate.type);
					}
				}
			});
		}
	}
}

function playItem(url, type) {
	console.log("Loading item.", url);
	var commandArgs = null;
	if (type === "video") {
		commandArgs = ["-b" , url];
	}
	else if (type === "stream") {
		commandArgs = ["-b" , "--live", url]
	}
	else {
		throw "Invalid item type.";
	}

	// force audio over hdmi
	commandArgs.push("-o");
	commandArgs.push("hdmi");
	
	// play item
	handle = spawn("omxplayer", commandArgs);
	// to try and prevent memory leak
	handle.stdout.resume();
	handle.stderr.resume();
	var closeEventHandled = false;
	playerProcessCloseCallback = function() {
		if (type === "stream") {
			// here because a stream just ended/lost connection
			// try and load the stream again
			// when the stream has actually been marked as over in the CMS
			// loadNextItem() will be called from liveStreamCheck()
			console.log("Stream terminated. Attempting to load again.");
			playItem(url, type);
		}
		else {
			liveCandidate = null;
			loadNextItem();
		}
	};
	
	handle.on("close", function() {
		if (closeEventHandled) {
			return;
		}
		closeEventHandled = true;
		handle = null;
		killPlayer(); // just to be certain
		playerProcessCloseCallback();
	});
}

function killPlayer() {
	exec('pkill omxplayer');
}

function startPeriodicGarbageCollection() {
	if (global.gc) {
		console.log("Performing garbage collection every 5 seconds.");
		setInterval(function() {
			// this will force garbage collection to run
			// fixed memory leak issue when running on a pi
			// In order for this to work the "--expose-gc" paramater must be added to the command
			global.gc();
		}, 5000);
	}
}

function shuffle(array) {
  var currentIndex = array.length, temporaryValue, randomIndex ;

  // While there remain elements to shuffle...
  while (0 !== currentIndex) {

    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }

  return array;
}