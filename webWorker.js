/**
 * RSS Live Links - an RSS "live bookmark" extension for Google Chrome
 *
 * Copyright 2012 Martin Bartlett
 *
 * This file has been modernized and made more robust using ES6 class syntax.
 * Note: This Web Worker is currently disabled in the extension's default configuration.
 */

class WebWorker {
    constructor() {
        this.requestId = 0;
        this.worker = new Worker('webWorkerRun.js');
        // 使用 Map 更适合频繁增删的场景
        this.requests = new Map();

        // 优化点 2: 使用箭头函数，自动绑定 this 上下文
        this.worker.addEventListener('message', (evt) => {
            this.processResponse(evt.data);
        }, false);

        // 也可以监听 Worker 的错误事件，增加健壮性
        this.worker.addEventListener('error', (err) => {
            console.error('An error occurred in the Web Worker:', err.message, err);
        });
    }

    runRequest(request, data, context, doneFunc, errFunc) {
        const id = `request_${this.requestId++}`;
        this.requests.set(id, { context, doneFunc, errFunc });
        this.worker.postMessage({ id, request, data });
        return id;
    }

    processResponse(response) {
        if (response.consoleMsg) {
            console.log("WebWorker Message: " + response.consoleMsg);
            return;
        }

        const { id, data } = response;
        let { error } = response;
        
        // console.log(`Received response for request: ${id}`);

        // 优化点 3: 必须将 request 声明为局部变量
        const request = this.requests.get(id);

        if (!request) {
            // 请求可能已被取消或处理过，直接忽略
            return;
        }

        // 确保在处理后删除请求，防止内存泄漏
        this.requests.delete(id);

        if (error) {
            // 优化点 3: 改进错误处理
            if (error instanceof Error) {
                error = `Error: ${error.message}`;
            } else if (typeof error === 'object' && error !== null) {
                error = `Error: ${JSON.stringify(error)}`;
            }
            console.error(`Web Worker error for request ${id}:`, error);
            
            if (request.errFunc) {
                // console.log(`Running error function for: ${id}`);
                request.errFunc(id, error, data, request.context);
            }
        } else if (request.doneFunc) {
            // console.log(`Running handler function for: ${id}`);
            request.doneFunc(id, data, request.context);
        }
    }

    cancelRequest(id) {
        // 使用 Map 的 delete 方法
        this.requests.delete(id);
    }

    terminate() {
        // terminate 函数是 worker 的方法，不需要 id
        this.worker.terminate();
        this.requests.clear(); // 清空请求 Map
        console.log('Web Worker terminated.');
    }
}