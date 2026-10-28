/**
 * RSS Live Links MV3 - an RSS "live bookmark" extension for Google Chrome / Edge
 *
 *    This file is part of RSS Live Links (LGPL-3.0, see LICENSE and COPYING).
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
 *
 * Manifest V3 service worker.
 *
 * The extension's background logic (feed parsing via DOMParser, canvas-based
 * icon animation, localStorage state, XHR with CORS fallback) requires DOM
 * APIs that are not available in a service worker.  It therefore runs in an
 * offscreen document (background.html), which this worker is responsible for
 * creating and keeping alive.
 */

const OFFSCREEN_DOCUMENT_URL = 'background.html';

let creatingOffscreenDocument = null;

async function hasOffscreenDocument() {
	if (chrome.offscreen.hasDocument) {
		return await chrome.offscreen.hasDocument();
	}
	// Fallback for older Chromium versions
	const matchedClients = await clients.matchAll();
	return matchedClients.some(client => client.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL));
}

async function ensureOffscreenDocument() {
	if (await hasOffscreenDocument()) {
		return;
	}
	// Guard against racing creation attempts
	if (creatingOffscreenDocument) {
		await creatingOffscreenDocument;
		return;
	}
	creatingOffscreenDocument = chrome.offscreen.createDocument({
		url: OFFSCREEN_DOCUMENT_URL,
		reasons: ['DOM_PARSER', 'BLOBS'],
		justification: 'Parse RSS/Atom feeds, render badge icon animation and store extension state (DOM APIs unavailable in a service worker).'
	});
	try {
		await creatingOffscreenDocument;
	} catch (err) {
		// "Only a single offscreen document" errors are fine - it already exists
		if (!err || !/single offscreen/i.test(String(err.message))) {
			console.error('Failed to create offscreen background document:', err);
		}
	} finally {
		creatingOffscreenDocument = null;
	}
}

chrome.runtime.onStartup.addListener(() => {
	ensureOffscreenDocument();
	reinjectContentScript();
});
chrome.runtime.onInstalled.addListener(() => {
	ensureOffscreenDocument();
	reinjectContentScript();
});

// The service worker is evaluated on every wake - make sure the offscreen
// document exists whenever the worker runs. Also re-inject findrss.js into
// existing tabs (MV3 content_scripts are NOT re-injected after extension reload).
ensureOffscreenDocument().then(reinjectContentScript);

/**
 * Re-inject findrss.js into all http/https tabs.
 * MV3 manifest content_scripts only fire on page navigation — when the extension
 * is reloaded, already-open tabs never get the content script.  This function
 * covers that gap, and also helps if the script was previously blocked by CSP.
 */
async function reinjectContentScript() {
	try {
		const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
		for (const tab of tabs) {
			try {
				await chrome.scripting.executeScript({
					target: { tabId: tab.id, allFrames: false },
					files: ['findrss.js'],
				});
			} catch (err) {
				// Frame-less tabs, already-injected, or blocked by CSP — ignore
			}
		}
	} catch (err) {
		// scripting.executeScript may fail in some contexts — safe to ignore
	}
}

/*
 * MV3: the offscreen document cannot drive browser UI, so it forwards every
 * chrome.action update (badge text/colour, title, icon, popup) here.
 */
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
	if (request && request.type === 'rssll_action') {
		applyActionUpdate(request);
	} else if (request && request.type === 'rssll_ui') {
		return handleUiCommand(request, sendResponse);
	}
	return false;
});

/*
 * Decoded animation frames, keyed by data URL.  The icon animation only
 * cycles through ~21 rotation angles, so caching the decoded ImageData keeps
 * per-frame work to a single Map lookup after the first revolution.
 */
var decodedIconCache = new Map();

async function applyActionUpdate(request) {
	try {
		var details = request.details;
		if (request.method === 'setIconImageData') {
			var dataUrl = details.dataUrl;
			var imageData = decodedIconCache.get(dataUrl);
			if (!imageData) {
				// ImageData itself cannot survive JSON messaging - rebuild it
				var blob = await (await fetch(dataUrl)).blob();
				var bmp = await createImageBitmap(blob);
				var cnv = new OffscreenCanvas(bmp.width, bmp.height);
				var ctx = cnv.getContext('2d');
				ctx.drawImage(bmp, 0, 0);
				imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
				if (decodedIconCache.size >= 64) {
					decodedIconCache.clear();
				}
				decodedIconCache.set(dataUrl, imageData);
			}
			details = {imageData: imageData};
		}
		if (request.method === 'setTitle') {
			// offscreen has no chrome.i18n - build the tooltip text here
			var title = "";
			if (details.updates === 1) {
				title += chrome.i18n.getMessage("icon_1_feed_updated");
			} else if (details.updates > 1) {
				title += chrome.i18n.getMessage("icon_n_feeds_updated", ["" + details.updates]);
			}
			if (details.errors === 1) {
				title += (title ? "\n" : "") + chrome.i18n.getMessage("icon_1_feed_error");
			} else if (details.errors > 0) {
				title += (title ? "\n" : "") + chrome.i18n.getMessage("icon_n_feeds_error", ["" + details.errors]);
			}
			details = {title: title || chrome.i18n.getMessage("extTitle")};
		}
		if (typeof chrome.action[request.method] === 'function') {
			chrome.action[request.method](details, function() {
				void chrome.runtime.lastError;
			});
		}
	} catch (e) {
		console.error("rssll_action '" + request.method + "' failed:", e);
	}
}

/*
 * MV3: the offscreen document cannot touch chrome.tabs / chrome.scripting
 * either - all tab operations requested by the background logic run here.
 */
function handleUiCommand(request, sendResponse) {
	if (request.cmd === 'openInTab') {
		chrome.tabs.query({}, function(views) {
			void chrome.runtime.lastError;
			var i;
			for (i = 0; i < views.length && views[i].url != request.url; ++i);
			var done = function(tab) {
				void chrome.runtime.lastError;
				sendResponse({tab: tab ? {id: tab.id} : null});
			};
			if (i < views.length) {
				chrome.tabs.update(views[i].id, {active: request.focus}, done);
			} else {
				chrome.tabs.create({url: request.url, active: request.focus, index: 5000}, done);
			}
		});
		return true; // respond asynchronously
	}
	if (request.cmd === 'activateTab') {
		chrome.tabs.update(request.tabId, {active: true}, function() {
			void chrome.runtime.lastError;
		});
		return false;
	}
	if (request.cmd === 'tabsQueryAll') {
		chrome.tabs.query({}, function(tabs) {
			void chrome.runtime.lastError;
			sendResponse({tabs: (tabs || []).map(function(t) { return {id: t.id, url: t.url}; })});
		});
		return true;
	}
	if (request.cmd === 'executeScript') {
		chrome.scripting.executeScript({
			target: {tabId: request.tabId, allFrames: true},
			files: ["findrss.js"]
		}, function() {
			void chrome.runtime.lastError;
		});
		return false;
	}
	return false;
}

/*
 * MV3: tab lifecycle events are received here and forwarded to the offscreen
 * document, which owns the feed-detection logic (tabFeeds bookkeeping).
 */
chrome.tabs.onUpdated.addListener(function(tabId, info, tab) {
	if (info.status === 'complete') {
		chrome.runtime.sendMessage({
			type: 'rssll_tab_event',
			event: 'updated',
			tabId: tabId,
			tab: {id: tabId, url: tab ? tab.url : undefined}
		}).catch(function() { /* offscreen document not ready */ });
	}
});

chrome.tabs.onRemoved.addListener(function(tabId) {
	chrome.runtime.sendMessage({
		type: 'rssll_tab_event',
		event: 'removed',
		tabId: tabId
	}).catch(function() { /* offscreen document not ready */ });
});
