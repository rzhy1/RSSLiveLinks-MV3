/**
 * RSS Live Links - 增强版：三代理轮询机制的CORS代理服务
 */
 
// 可用的CORS代理服务列表（按优先级排序）
const CORS_PROXY_SERVICES = [   
	{
        name: 'Cloudflare Workers',
        format: url => `https://hidden-poetry-f91c.rzhyhc.workers.dev/?url=${encodeURIComponent(url)}`
    },
    {
        name: 'allorigins.win',
        format: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    },
    {
        name: 'corsproxy.io',
        format: url => `https://corsproxy.io/?${encodeURIComponent(url)}`
    }
];

// 当前使用的代理索引
let currentProxyIndex = 0;

function XMLHttpRequestManager() {
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxRunning = 4;
}

XMLHttpRequestManager.prototype.setMaxRunning = function(maxRunning) {
    this.maxRunning = Math.max(1, parseInt(maxRunning, 10) || 4);
};

XMLHttpRequestManager.prototype._requestFinished = function() {
    this.activeRequests--;
    if (this.requestQueue.length > 0) {
        this._runNextInQueue();
    }
};

XMLHttpRequestManager.prototype._runNextInQueue = function() {
    if (this.activeRequests < this.maxRunning && this.requestQueue.length > 0) {
        const requestData = this.requestQueue.shift();
        if (requestData) {
            this.activeRequests++;
            new XMLHttpRequestor(this, requestData);
        }
    }
};

XMLHttpRequestManager.prototype.runRequest = function(url, context, doneFunc, failFunc, timeout) {
    const requestData = { 
        url, 
        context, 
        doneFunc, 
        failFunc, 
        timeout, 
        isProxied: false,
        proxyIndex: -1,  // -1 表示未使用代理
        retryCount: 0    // 重试计数器
    };
    this.requestQueue.push(requestData);
    this._runNextInQueue();
};


function XMLHttpRequestor(manager, requestData) {
    this.manager = manager;
    this.requestData = requestData;
    this.isRetrying = false;
    this._run();
}

XMLHttpRequestor.prototype._run = function() {
    const xhr = new XMLHttpRequest();
    const { url, timeout, doneFunc, failFunc, context, isProxied, proxyIndex } = this.requestData;

    xhr.addEventListener('loadend', () => {
        if (!this.isRetrying) {
            this.manager._requestFinished();
        }
    });
    
    // 确定请求URL
    let requestUrl;
    if (isProxied && proxyIndex >= 0 && proxyIndex < CORS_PROXY_SERVICES.length) {
        const proxyService = CORS_PROXY_SERVICES[proxyIndex];
        console.log(`Using proxy: ${proxyService.name}`);
        requestUrl = proxyService.format(url);
    } else {
        requestUrl = url;
    }
    
    xhr.open("GET", requestUrl, true);
    
    const timeoutSeconds = parseInt(timeout, 10);
    xhr.timeout = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0; 
    
    // 仅对原始请求禁用缓存
    if (!isProxied) {
        xhr.setRequestHeader("Cache-Control", "no-cache, no-store, max-age=0");
        xhr.setRequestHeader("Pragma", "no-cache");
    }
    
    xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
            // 代理请求成功时，如果当前索引不是首选代理，则恢复首选
            if (isProxied && proxyIndex !== 0) {
                console.log(`Proxy ${CORS_PROXY_SERVICES[proxyIndex].name} succeeded, reverting to primary proxy`);
                currentProxyIndex = 0;
            }
            doneFunc(context, xhr.responseXML, xhr.responseText);
        } else {
            this.handleFailure(`HTTP Error: ${xhr.status} - ${xhr.statusText}`);
        }
    };

    xhr.onerror = () => {
        this.handleFailure("Network request failed");
    };

    xhr.ontimeout = () => {
        this.handleFailure(`Request timed out after ${timeoutSeconds} seconds`);
    };

    try {
        xhr.send();
    } catch (e) {
        this.handleFailure(`Failed to send request: ${e.message}`);
    }
};

XMLHttpRequestor.prototype.handleFailure = function(errorMessage) {
    const { url, context, failFunc, isProxied, proxyIndex, retryCount } = this.requestData;

    // 动态计算最大重试次数（1次原始请求 + 所有代理各1次）
    const MAX_RETRIES = 1 + CORS_PROXY_SERVICES.length;
    
    if (retryCount >= MAX_RETRIES) {
        failFunc(context, `All attempts failed: ${errorMessage}`);
        return;
    }

    if (isProxied) {
        // 代理请求失败 - 尝试下一个代理
        const nextProxyIndex = (proxyIndex + 1) % CORS_PROXY_SERVICES.length;
        
        console.warn(`Proxy ${CORS_PROXY_SERVICES[proxyIndex].name} failed (${errorMessage}), switching to: ${CORS_PROXY_SERVICES[nextProxyIndex].name}`);
        
        this.isRetrying = true;
        this.requestData.proxyIndex = nextProxyIndex;
        this.requestData.retryCount = retryCount + 1;
        
        // 更新全局当前代理索引
        currentProxyIndex = nextProxyIndex;
        
        this.manager._requestFinished();
        this.manager.requestQueue.unshift(this.requestData);
        this.manager._runNextInQueue();
    } else {
        // 原始请求失败 - 切换到代理模式
        console.warn(`Direct request failed for ${url}, enabling proxy mode (${errorMessage})`);
        this.isRetrying = true;
        
        this.requestData.isProxied = true;
        this.requestData.proxyIndex = currentProxyIndex;
        this.requestData.retryCount = retryCount + 1;
        
        this.manager._requestFinished();
        this.manager.requestQueue.unshift(this.requestData);
        this.manager._runNextInQueue();
    }
};