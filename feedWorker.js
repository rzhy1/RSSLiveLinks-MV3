/**
 * RSS Live Links - Final, robust worker with dual XML/JSON support.
 * This version fixes a critical XML parsing bug and simplifies the diffing
 * algorithm for maximum stability.
 */
// ===================================================================
// ==================== 1. 辅助函数 ==================================
// ===================================================================

function hashString(str) {
  let hash = 0;
  if (typeof str !== 'string' || str.length === 0) return '0';
  for (let i = 0, len = str.length; i < len; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function localRunRequest(request, data, feed) {
	data.testing = {feed: feed}
	runUpdate(1, data);
}

var xmlNamespace = "http://www.w3.org/XML/1998/namespace";

// ===================================================================
// ==================== 2. 核心请求与解析逻辑 =======================
// ===================================================================

function runUpdate(id, data) {
	// 自愈：管理器未初始化时按需创建（初始化失败或切换策略期间兜底）
	if (!xmlHttpRequestManager) {
		xmlHttpRequestManager = new XMLHttpRequestManager();
	}
	data.response = {};
	data.id = id;
	var feed = data.feed;
	data.response.feed = {
		updateCycleId: feed.updateCycleId,
		baseURL: feed.baseURL,
		parentURL: feed.parentURL,
		itemGuids: feed.itemGuids,
		itemsByGuid: feed.itemsByGuid,
		deletedItems: feed.deletedItems,
		moreStories: feed.moreStories,
		txtHash: feed.txtHash,
		ttl: feed.ttl,
		pubDate: feed.pubDate,
		stats: feed.stats,
		faviconURL: feed.faviconURL
	};
	xmlHttpRequestManager.runRequest(data.url, data, handleResponse, handleError, data.timeout);
};

function endUpdate (data, changed) {
	var response = data.response;
	response.changed = changed;
	if (data.testing) {
		var feed = data.testing.feed;
		feed.handleUpdate(response);
	} else {
		if(typeof returnResponse === 'function') {
			returnResponse(data.id, response);
		}
	}
}

function handleResponse(data, doc, txt) {
	try {
        if (!txt || txt.trim() === '') throw new Error("Received empty response from server.");

        // 防御：剥离 BOM 和前置空白，避免编码污染导致格式误判
        const cleaned = txt.replace(/^\uFEFF/, '').trim();
        const firstChar = cleaned.charAt(0);

        if (firstChar === '<') {
			// 防御：如果内容其实是 HTML 错误页，直接提取可读错误信息
			if (/^\s*<\s*!doctype\s+html/i.test(cleaned) || /^\s*<\s*html[\s>]/i.test(cleaned)) {
				const titleMatch = cleaned.match(/<title[^>]*>([^<]+)<\/title>/i);
				const h1Match = cleaned.match(/<h1[^>]*>([^<]+)<\/h1>/i);
				const snippet = cleaned.substring(0, 200);
				const errDesc = titleMatch ? titleMatch[1] : (h1Match ? h1Match[1] : snippet);
				throw new Error("Server returned HTML error page: " + errDesc);
			}

			const cleanedTxt = cleaned.replace(/&(?!lt;|gt;|amp;|apos;|quot;|#\d+;|#x[\da-f]+;)/gi, '&amp;')
			const parser = new DOMParser();
			doc = parser.parseFromString(cleanedTxt, "application/xml");
			const parserError = doc.getElementsByTagName("parsererror");
			if (parserError.length > 0) {
				// 防御：XML 解析失败时，附带原始响应前 100 字符，方便定位服务器到底返回了什么
				const preview = cleaned.substring(0, 100);
				throw new Error("XML Parsing Error: " + parserError[0].textContent.trim() + "\nResponse preview: " + preview);
			}
            endUpdate(data, populateFromXML(data, doc, cleaned, null));

        } else if (firstChar === '{') {
            const jsonData = JSON.parse(cleaned);
            endUpdate(data, populateFromJSON(data, jsonData, cleaned, null));
        } else {
			// 防御：无法识别格式时，显示前 100 字符帮助判断
			const preview = cleaned.substring(0, 100);
            throw new Error("Unrecognized feed format. Response starts with: " + preview);
        }
	} catch (e) {
		var stack = e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : 'No stack trace';
		data.response.error = `Feed processing error: ${e.message}\n${stack}`;
		endUpdate(data, false);
	}
}

function handleError(data, errorText) {
	data.response.error = errorText;
	endUpdate(data, false);
}

// ===================================================================
// ==================== 3. 数据填充与转换 ==========================
// ===================================================================

function hasContentChanged(data, txt, txtHash) {
    // Use pre-computed hash if available, otherwise compute sync hash
    var newHash = txtHash || sha256Sync(txt);
    if (data.feed.txtHash === newHash) return false;
    data.response.feed.txtHash = newHash;
    return true;
}

function populateFromXML (data, doc, txt, txtHash) {
	if (!hasContentChanged(data, txt, txtHash)) return false;
    var responseFeed = data.response.feed;
	var dateString = (doc.querySelector("channel > lastBuildDate, feed > updated, channel > pubDate"))?.textContent || '';
	responseFeed.pubDate = dateString ? createDate(dateString) : new Date();
	var linkNode = doc.querySelector("channel > link, feed > link[rel='alternate']");
    responseFeed.moreStories = (linkNode ? (linkNode.getAttribute('href') || getInner(linkNode, null)) : null) || getRootURL(data.url);
	var titleNode = doc.querySelector("channel > title, feed > title");
    if(titleNode) responseFeed.feedTitle = trim11(getInner(titleNode,"Unknown Feed"));
	var myFavIconURL = data.feed.faviconURL;
	if (!myFavIconURL && responseFeed.moreStories) myFavIconURL = getRootURL(responseFeed.moreStories) + "/favicon.ico";
	if (myFavIconURL) responseFeed.faviconURL = myFavIconURL;
	var ttlContent = doc.querySelector("channel > ttl")?.textContent || "0";
	responseFeed.ttl = parseInt(ttlContent, 10) || 0;
	var items = doc.querySelectorAll('item, entry');
	var newItems = Array.from(items).map(itemXML => getFeedItemFromXML(itemXML, data));
    return processItems(data, newItems);
}

function populateFromJSON(data, jsonData, txt, txtHash) {
    if (!hasContentChanged(data, txt, txtHash)) return false;
    var responseFeed = data.response.feed;
    responseFeed.feedTitle = jsonData.title || "Unknown Feed";
    responseFeed.moreStories = jsonData.home_page_url || getRootURL(data.url);
    responseFeed.faviconURL = jsonData.icon || jsonData.favicon;
    responseFeed.ttl = 0;
    if (jsonData.items && jsonData.items.length > 0 && jsonData.items[0].date_published) {
        responseFeed.pubDate = createDate(jsonData.items[0].date_published);
    } else {
        responseFeed.pubDate = new Date();
    }
    var newItems = (jsonData.items || []).map(itemJSON => getFeedItemFromJSON(itemJSON));
    return processItems(data, newItems);
}

function getInner(parnt, dflt) {
	var rc = dflt;
	if (parnt) rc = parnt.textContent || (parnt.firstChild ? parnt.firstChild.nodeValue : '');
	return rc || dflt;
}

function getFeedItemFromXML(itemXML, data) {
	var newItem = {};
	newItem.description = itemXML.querySelector('description, content')?.textContent || '';
	newItem.title = trim11(itemXML.querySelector('title')?.textContent || "Unknown title") || undefined;
	var linkNode = itemXML.querySelector("link[rel='alternate'][type='text/html']") || itemXML.querySelector('link');
	var itemUrlString = linkNode ? (linkNode.getAttribute("href") || getInner(linkNode, '')) : '';
	itemUrlString = trim11(itemUrlString);
	if (itemUrlString) {
	   	try { newItem.url = new URL(itemUrlString, data.feed.baseURL).href; }
        catch(e) { newItem.url = itemUrlString; }
	} else {
		newItem.url = undefined;
    }
	var pubDateContent = itemXML.querySelector('pubDate, updated')?.textContent;
	newItem.pubDate = pubDateContent ? createDate(pubDateContent) : new Date();
	let guidStr = trim11(itemXML.querySelector('guid, id')?.textContent || '');
	if (!guidStr) guidStr = newItem.url || `gen:title|${newItem.title}`;
    newItem.guid = guidStr;
	return newItem;	
}

function getFeedItemFromJSON(itemJSON) {
    var newItem = {};
    newItem.title = trim11(itemJSON.title || 'Untitled');
    newItem.url = itemJSON.url || itemJSON.external_url;
    newItem.description = itemJSON.content_html || itemJSON.content_text || (itemJSON.summary || '');
    newItem.pubDate = itemJSON.date_published ? createDate(itemJSON.date_published) : new Date();
    newItem.guid = itemJSON.id; 
    if (!newItem.guid) newItem.guid = newItem.url || `gen:no-id|${newItem.title}`;
    return newItem;
}

// ===================================================================
// ==================== 4. 统一的差异计算逻辑 =======================
// ===================================================================

function processItems(data, newItems) {
    var response = data.response;
	var feed = data.feed;
	var responseFeed = response.feed;
	responseFeed.updateCycleId++;

	var newItemGuids = [];
	var newItemsByGuid = {};
	var additions = 0, deletions = 0, mods = 0, moves = 0;

	newItems.forEach(newItem => {
		if (!newItem.guid || newItemsByGuid[newItem.guid]) return;
		var oldItem = feed.itemsByGuid[newItem.guid];
		if (oldItem) {
			if (oldItem.title != newItem.title || oldItem.url != newItem.url || oldItem.description != newItem.description) {
				mods++;
				newItem.modified = true;
			}
		} else {
			++additions;
			newItem.added = true;
		}
		newItemGuids.push(newItem.guid);
		newItemsByGuid[newItem.guid] = newItem;
	});

    var newGuidsSet = new Set(newItemGuids);
    var newDeletedItems = [];
	feed.itemGuids.forEach(oldGuid => {
		if (!newGuidsSet.has(oldGuid)) {
			deletions++;
			newDeletedItems.push(oldGuid);
		}
	});

    // 为了稳定性和简化，不检测条目的“移动”(moves)。
    moves = 0;

	var changed = (additions > 0 || deletions > 0 || mods > 0);
	if (changed) {
		responseFeed.itemsByGuid = newItemsByGuid;
		responseFeed.itemGuids = newItemGuids;
		responseFeed.deletedItems = newDeletedItems;
	}
	responseFeed.stats = {additions, deletions, moves, mods};
	return changed;
}