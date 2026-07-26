/**
 * 小八金融 - 在线股票查询应用
 *
 * 使用 sql.js-httpvfs 在浏览器端通过 HTTP Range 请求按需读取 SQLite 数据库
 * 使用 LightweightCharts 渲染 K线图 + 成交量柱状图
 */

(function () {
    'use strict';

    // ========== 配置 ==========
    const DB_URL = 'db/xiaoba-finance-optimized.db';
    const WORKER_URL = 'sqlite.worker.js';
    const WASM_URL = 'sql-wasm.wasm';
    const MAX_BYTES_TO_READ = 10 * 1024 * 1024; // 10MB

    // ========== DOM 元素 ==========
    const stockSelect = document.getElementById('stock-select');
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const queryBtn = document.getElementById('query-btn');
    const statusBar = document.getElementById('status-bar');
    const chartContainer = document.getElementById('chart-container');
    const dataTable = document.getElementById('data-table');
    const tableBody = document.getElementById('data-tbody');
    const tableEmpty = document.getElementById('table-empty');
    const unsupportedMsg = document.getElementById('unsupported-msg');

    // ========== 全局状态 ==========
    let dbWorker = null;
    let chart = null;
    let candleSeries = null;
    let volumeSeries = null;
    let isQuerying = false;

    // ========== 浏览器兼容性检测 ==========
    function checkBrowserSupport() {
        const hasWASM = typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
        const hasWorker = typeof Worker !== 'undefined';
        if (!hasWASM || !hasWorker) {
            unsupportedMsg.style.display = 'block';
            queryBtn.disabled = true;
            return false;
        }
        return true;
    }

    // ========== 日期工具 ==========
    function formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function setDefaultDates() {
        const today = new Date();
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(today.getMonth() - 3);
        endDateInput.value = formatDate(today);
        startDateInput.value = formatDate(threeMonthsAgo);
    }

    // ========== 状态提示 ==========
    function setStatus(type, message, withSpinner) {
        statusBar.className = `status-bar status-${type}`;
        const spinnerHtml = withSpinner ? '<span class="spinner"></span>' : '';
        statusBar.innerHTML = `${spinnerHtml}<span>${message}</span>`;
    }

    function clearStatus() {
        statusBar.innerHTML = '';
        statusBar.className = 'status-bar';
    }

    // ========== sql.js-httpvfs 初始化 ==========
    async function initDbWorker() {
        if (dbWorker) return dbWorker;

        setStatus('info', '正在初始化数据库引擎...', true);

        // 动态加载 sql.js-httpvfs 的 UMD bundle
        // index.js 是 UMD 格式，在浏览器中会将 createDbWorker 挂载到 window
        await loadScript('index.js');

        if (typeof window.createDbWorker !== 'function') {
            throw new Error('sql.js-httpvfs 库加载失败');
        }

        const config = {
            from: 'inline',
            config: {
                serverMode: 'full',
                requestChunkSize: 1024, // 匹配 DB page_size
                url: DB_URL
            }
        };

        dbWorker = await window.createDbWorker(
            [config],
            WORKER_URL,
            WASM_URL,
            MAX_BYTES_TO_READ
        );

        return dbWorker;
    }

    // 动态加载脚本
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    // ========== 查询逻辑 ==========
    async function queryData(market, code, startDate, endDate) {
        const worker = await initDbWorker();

        const sql = `SELECT * FROM stock_daily WHERE market = ? AND code = ? AND date BETWEEN ? AND ? ORDER BY date`;
        const result = await worker.db.exec(sql, [market, code, startDate + ' 00:00:00', endDate + ' 00:00:00']);

        if (!result || result.length === 0) {
            return [];
        }

        const rows = result[0].values;
        const columns = result[0].columns;

        // 转换为对象数组
        return rows.map(row => {
            const obj = {};
            columns.forEach((col, i) => {
                obj[col] = row[i];
            });
            return obj;
        });
    }

    // ========== 输入校验 ==========
    function validateInput() {
        const stockValue = stockSelect.value;
        if (!stockValue) {
            setStatus('error', '⚠️ 请选择股票代码');
            return null;
        }

        const startDate = startDateInput.value;
        const endDate = endDateInput.value;

        if (!startDate || !endDate) {
            setStatus('error', '⚠️ 请选择日期范围');
            return null;
        }

        if (startDate > endDate) {
            setStatus('error', '⚠️ 开始日期不能晚于结束日期');
            return null;
        }

        const [market, code] = stockValue.split('|');
        return { market, code, startDate, endDate };
    }

    // ========== 执行查询 ==========
    async function executeQuery() {
        if (isQuerying) return;

        const params = validateInput();
        if (!params) return;

        isQuerying = true;
        queryBtn.disabled = true;
        queryBtn.textContent = '查询中...';
        setStatus('info', '正在查询数据...', true);

        try {
            const data = await queryData(params.market, params.code, params.startDate, params.endDate);

            if (data.length === 0) {
                setStatus('empty', '未找到该股票在选定日期范围内的数据');
                clearChart();
                renderTable([]);
                return;
            }

            renderChart(data);
            renderTable(data);
            setStatus('success', `✅ 查询完成，共 ${data.length} 条记录`);

        } catch (err) {
            console.error('查询失败:', err);
            setStatus('error', `❌ 查询失败: ${err.message || '未知错误'}`);
            clearChart();
            renderTable([]);
        } finally {
            isQuerying = false;
            queryBtn.disabled = false;
            queryBtn.textContent = '🔍 查询';
        }
    }

    // ========== LightweightCharts 渲染 ==========
    function initChart() {
        if (chart) {
            chart.remove();
            chart = null;
        }

        // Clear placeholder before creating chart
        chartContainer.innerHTML = '';

        const chartOptions = {
            layout: {
                background: { type: 'solid', color: '#ffffff' },
                textColor: '#333',
            },
            grid: {
                vertLines: { color: '#f0f0f0' },
                horzLines: { color: '#f0f0f0' },
            },
            crosshair: { mode: 0 }, // Normal crosshair
            rightPriceScale: {
                borderColor: '#e2e8f0',
            },
            timeScale: {
                borderColor: '#e2e8f0',
                timeVisible: false,
                secondsVisible: false,
            },
            autoSize: true,
        };

        chart = LightweightCharts.createChart(chartContainer, chartOptions);

        // 蜡烛图系列
        candleSeries = chart.addCandlestickSeries({
            upColor: '#ef5350',
            downColor: '#26a69a',
            borderUpColor: '#ef5350',
            borderDownColor: '#26a69a',
            wickUpColor: '#ef5350',
            wickDownColor: '#26a69a',
            priceScaleId: 'right',
        });

        candleSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.05, bottom: 0.25 },
        });

        // 成交量柱状图系列（使用 overlay 刻度）
        volumeSeries = chart.addHistogramSeries({
            color: '#26a69a',
            priceFormat: { type: 'volume' },
            priceScaleId: '',
        });

        volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
        });
    }

    function renderChart(data) {
        initChart();

        // 转换数据为 LightweightCharts 格式
        const candleData = [];
        const volumeData = [];

        data.forEach(row => {
            // 日期格式: "2025-01-02 00:00:00" -> "2025-01-02"
            const dateStr = String(row.date).split(' ')[0];
            const time = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);

            candleData.push({
                time: time,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
            });

            // 成交量颜色：阳线绿，阴线红（中国市场配色）
            const isUp = row.close >= row.open;
            volumeData.push({
                time: time,
                value: row.volume || 0,
                color: isUp ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
            });
        });

        candleSeries.setData(candleData);
        volumeSeries.setData(volumeData);

        // 自动缩放到数据范围
        chart.timeScale().fitContent();
    }

    function clearChart() {
        if (chart) {
            chart.remove();
            chart = null;
            candleSeries = null;
            volumeSeries = null;
        }
        chartContainer.innerHTML = '<div class="chart-placeholder">请选择股票和日期范围后点击查询</div>';
    }

    // ========== 表格渲染 ==========
    function renderTable(data) {
        if (data.length === 0) {
            dataTable.style.display = 'none';
            tableEmpty.style.display = 'block';
            tableEmpty.textContent = '暂无数据';
            return;
        }

        dataTable.style.display = 'table';
        tableEmpty.style.display = 'none';

        tableBody.innerHTML = data.map(row => {
            const dateStr = String(row.date).split(' ')[0];
            const pctChange = row.pct_change;
            let pctClass = 'pct-flat';
            let pctText = '-';

            if (pctChange !== null && pctChange !== undefined) {
                const pct = (pctChange * 100).toFixed(2);
                if (pctChange > 0) {
                    pctClass = 'pct-up';
                    pctText = `+${pct}%`;
                } else if (pctChange < 0) {
                    pctClass = 'pct-down';
                    pctText = `${pct}%`;
                } else {
                    pctText = '0.00%';
                }
            }

            const fmt = (v) => (v !== null && v !== undefined) ? Number(v).toFixed(2) : '-';
            const fmtVol = (v) => {
                if (v === null || v === undefined) return '-';
                if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
                if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
                return v.toFixed(0);
            };

            return `<tr>
                <td>${dateStr}</td>
                <td>${fmt(row.open)}</td>
                <td>${fmt(row.close)}</td>
                <td>${fmt(row.high)}</td>
                <td>${fmt(row.low)}</td>
                <td>${fmtVol(row.volume)}</td>
                <td class="${pctClass}">${pctText}</td>
            </tr>`;
        }).join('');
    }

    // ========== 事件绑定 ==========
    queryBtn.addEventListener('click', executeQuery);

    // 回车键触发查询
    [stockSelect, startDateInput, endDateInput].forEach(el => {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') executeQuery();
        });
    });

    // ========== 初始化 ==========
    function init() {
        if (!checkBrowserSupport()) return;
        setDefaultDates();
        setStatus('info', '💡 选择股票和日期范围后点击查询按钮');
    }

    init();
})();
