/**
 * RSS Live Links - an RSS "live bookmark" extension for Google Chrome / Edge
 *
 *    This file is part of RSS Live Links.
 *
 *    RSS Live Links is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Lesser General Public License as published by
 *    the Free Software Foundation, either version 3 of the License, or
 *    (at your option) any later version.
 *
 *    RSS Live Links is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Lesser General Public License for more details.
 *
 *    You should have received a copy of the GNU Lesser General Public License
 *    along with RSS Live Links.  If not, see <http://www.gnu.org/licenses/>.
 *
 * New file for the Manifest V3 port, 2026-10-28 by rzhy1. See NOTICE.
 */

/*
 * MV3 bridge (client side).
 *
 * In Manifest V2 the UI pages (popup, options, subscribe) accessed the
 * background page directly via chrome.extension.getBackgroundPage().
 * In Manifest V3 the background logic runs in an offscreen document, so all
 * access goes through chrome.runtime messaging.  This module provides:
 *
 *   bgBridge.init(usePort)  - fetch a full state snapshot (returns a Promise)
 *   bgBridge.call(fn, args) - invoke a background function, Promise result
 *   bgBridge.send(fn, args) - fire-and-forget invocation
 *   bgBridge.on(event, cb)  - listen for pushed state updates (needs port)
 *
 * It also hosts Feed "replicas" (popup-side mirrors of background Feed
 * objects) and the helpers that used to live in the background page
 * (sortFeedItems, applyStyleOptions).
 */

var bgBridge = (function() {
	var state = null;
	var port = null;
	var eventHandlers = {};

	function handlePortMessage(msg) {
		if (!msg || msg.type !== 'rssll_event') {
			return;
		}
		var handler = eventHandlers[msg.event];
		if (handler) {
			try {
				handler(msg);
			} catch(e) {
				console.error("bgBridge event handler error:", e);
			}
		}
	}

	return {
		init: function(usePort) {
			return new Promise(function(resolve, reject) {
				chrome.runtime.sendMessage({type: 'rssll_get_state'}, function(resp) {
					var err = chrome.runtime.lastError;
					if (err) {
						reject(new Error(err.message));
						return;
					}
					state = resp;
					if (usePort) {
						port = chrome.runtime.connect({name: 'rssll-popup'});
						port.onMessage.addListener(handlePortMessage);
					}
					resolve(state);
				});
			});
		},
		on: function(event, cb) {
			eventHandlers[event] = cb;
		},
		call: function(fn, args) {
			return new Promise(function(resolve, reject) {
				chrome.runtime.sendMessage({type: 'rssll_call', fn: fn, args: args || [], needResponse: true}, function(resp) {
					var err = chrome.runtime.lastError;
					if (err) {
						reject(new Error(err.message));
						return;
					}
					if (resp && resp.error) {
						reject(new Error(resp.error));
						return;
					}
					resolve(resp ? resp.result : undefined);
				});
			});
		},
		send: function(fn, args) {
			try {
				chrome.runtime.sendMessage({type: 'rssll_call', fn: fn, args: args || []});
			} catch(e) { /* page is closing */ }
		},
		getState: function() {
			return state;
		},
		// Re-fetch the complete snapshot (e.g. after an import)
		refreshState: function() {
			return new Promise(function(resolve, reject) {
				chrome.runtime.sendMessage({type: 'rssll_get_state'}, function(resp) {
					var err = chrome.runtime.lastError;
					if (err) {
						reject(new Error(err.message));
						return;
					}
					state = resp;
					resolve(state);
				});
			});
		},
		setOptions: function(newOptions) {
			state.options = newOptions;
		}
	};
})();

/*
 * Feed replica handling.
 *
 * Popup-side Feed objects are plain data mirrors built from serialized
 * snapshots, but share the Feed prototype so all read-only methods
 * (getItems, hasUnseen, isRead, ...) behave exactly as in the background.
 * Mutating methods are overridden to also forward the call to the
 * background document, which owns the canonical objects.
 */

// The Feed prototype methods below are self-contained; saveSeenStates is a
// background-page global, so provide a no-op here to keep the prototype safe.
if (typeof saveSeenStates === 'undefined') {
	var saveSeenStates = function(feed) {};
}

function reviveFeedItem(item) {
	if (item && item.pubDate && !(item.pubDate instanceof Date)) {
		item.pubDate = new Date(item.pubDate);
	}
	return item;
}

function applyFeedSnapshot(replica, snap) {
	replica.name = snap.name;
	replica.url = snap.url;
	replica.feedTitle = snap.feedTitle;
	replica.error = snap.error;
	replica.updating = snap.updating;
	replica.group = snap.group;
	replica.sortItems = snap.sortItems;
	replica.maxItems = snap.maxItems;
	replica.itemsSize = snap.itemsSize;
	replica.maxItemsSize = snap.maxItemsSize;
	replica.imageSrc = snap.imageSrc;
	replica.ttl = snap.ttl;
	replica.updated = snap.updated ? new Date(snap.updated) : null;
	replica.expire = snap.expire ? new Date(snap.expire) : 0;
	replica._seenStates = snap._seenStates || {};
	replica._unseenCount = snap._unseenCount || 0;
	replica._unreadCount = snap._unreadCount || 0;
	var snapData = snap.data || {};
	var itemsByGuid = snapData.itemsByGuid || {};
	for (var guid in itemsByGuid) {
		reviveFeedItem(itemsByGuid[guid]);
	}
	replica.data = {
		updateCycleId: 0,
		baseURL: undefined,
		parentURL: undefined,
		deletedItems: [],
		itemGuids: snapData.itemGuids || [],
		itemsByGuid: itemsByGuid,
		moreStories: snapData.moreStories,
		txtHash: "",
		pubDate: snapData.pubDate ? new Date(snapData.pubDate) : null,
		faviconURL: snapData.faviconURL,
		stats: {added: 0, deleted: 0, modified: 0, unmodified: 0},
		defaultTtl: 0,
		ttl: snapData.ttl
	};
	// Mirror the background behaviour of updating a popup-held feed icon
	if (replica.image && snap.imageSrc && replica.image.src != snap.imageSrc) {
		replica.image.src = snap.imageSrc;
	}
}

function makeFeedReplica(snap) {
	var replica = Object.create(Feed.prototype);
	applyFeedSnapshot(replica, snap);

	// Mutations: apply locally for instant UI feedback, forward to background
	['setSeen', 'setRead', 'unsetRead'].forEach(function(method) {
		replica[method] = function(guid) {
			Feed.prototype[method].call(this, guid);
			bgBridge.send(method, [this.url, guid]);
		};
	});
	replica.loadFeed = function(dfltTimeout) {
		this.updating = true;
		bgBridge.send('loadFeed', [this.url, dfltTimeout]);
	};
	return replica;
}

/*
 * Moved from the background page (used to be backgroundPage.sortFeedItems).
 */
function sortFeedItems(feedObject, itemArray, sortItemsDefault) {
	var algorithm = (feedObject.sortItems ? (feedObject.sortItems - 1) : sortItemsDefault);
	if (!algorithm)
		return;

	if (algorithm == 1) {
		itemArray.sort(
			function(item1, item2) {
				var title1 = getItemTitle(item1)
				var title2 = getItemTitle(item2);
				return (title1 ? (title2 ? title1.localeCompare(title2) : 1) : (title2 ? -1 : 0));
			}
		);
	} else if (algorithm < 4) {
		itemArray.sort(
			function(item1, item2) {
				var date1 = item1.pubDate;
				var date2 = item2.pubDate;
				var val = (date1 ? (date2 ? date1.getTime() - date2.getTime() : 1) : (date2 ? -1 : 0));
				return (algorithm == 2 ? val : (0-val));
			}
		);
	}
}

/*
 * Moved from the background page (used to be backgroundPage.applyStyleOptions).
 */
var fontStrings = {
	sans_serif: "Sans-serif",
	serif: "Serif",
	arial: "Arial, Helvetica, sans-serif",
	arial_black: "'Arial Black', Gadget, sans-serif",
	bookman_old_style: "'Bookman Old Style', serif",
	comic_sans_ms: "'Comic Sans MS', cursive",
	garamond: "Garamond, serif",
	geneva: "Geneva, sans-serif",
	georgia: "Georgia, serif",
	impact: "Impact, Charcoal, sans-serif",
	lucida_sans_unicode: "'Lucida Sans Unicode', 'Lucida Grande', sans-serif",
	ms_sans_serif: "'MS Sans Serif', Geneva, sans-serif",
	ms_serif: "'MS Serif', 'New York', sans-serif",
	palatino_linotype: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
	tahoma: "Tahoma, Geneva, sans-serif",
	times_new_roman: "'Times New Roman', Times, serif",
	trebuchet_ms: "'Trebuchet MS', Helvetica, sans-serif",
	verdana: "Verdana, Geneva, sans-serif"
};

function applyStyleOptions(styleSheets, options) {
	for (var styleClass in options.styleOptions) {
		var styles = options.styleOptions[styleClass];
		var declaration = "";
		for (var property in styles) {
			var propertyValue = styles[property];
			if (property == "font-family" && fontStrings[propertyValue]) {
				propertyValue = fontStrings[propertyValue];
			}
			declaration += property +":"+propertyValue+";";
		}

		styleSheets[styleSheets.length-1].addRule("." + styleClass, declaration);
	}
}
