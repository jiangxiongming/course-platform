/**
 * server.js — 极简学习平台服务器
 * 
 * 启动：node server.js
 * 打开：http://localhost:3000
 * 
 * 功能：
 *   - 用户输入课程需求 → 调 pipeline.js 生成内容 → 展示
 *   - 课堂功能通过 iframe 嵌入 OpenMAIC（https://zfx2026.zeabur.app）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const OPENMAIC_URL = "https://zfx2026.zeabur.app";

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

// Serve static files
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Call pipeline.js
function runPipeline(userInput) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const scriptPath = path.join(__dirname, 'pipeline.js');
    exec(`node "${scriptPath}" "${userInput.replace(/"/g, '\\"')}"`, {
      timeout: 120000,
      maxBuffer: 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) return reject(err.message);
      // Find JSON in output
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return reject('No JSON output found');
      try {
        resolve(JSON.parse(jsonMatch[0]));
      } catch (e) {
        reject('JSON parse failed: ' + e.message);
      }
    });
  });
}

// HTML pages
function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>智慧学习大脑</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #333; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1F4E79, #2E75B6); color: white; padding: 24px 40px; }
  .header h1 { font-size: 24px; font-weight: 600; }
  .header p { font-size: 14px; opacity: 0.8; margin-top: 4px; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px; }
  .input-box { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; }
  .input-box textarea { width: 100%; min-height: 80px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; resize: vertical; }
  .input-box textarea:focus { outline: none; border-color: #2E75B6; box-shadow: 0 0 0 3px rgba(46,117,182,0.1); }
  .btn { background: #2E75B6; color: white; border: none; padding: 10px 28px; border-radius: 8px; font-size: 15px; cursor: pointer; margin-top: 12px; }
  .btn:hover { background: #1F4E79; }
  .btn:disabled { background: #999; cursor: not-allowed; }
  .loading { display: none; text-align: center; padding: 40px; color: #666; }
  .loading .spinner { border: 3px solid #eee; border-top: 3px solid #2E75B6; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .result { display: none; }
  .course-card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 16px; overflow: hidden; }
  .course-header { padding: 20px 24px; border-bottom: 1px solid #eee; }
  .course-header h2 { font-size: 18px; color: #1F4E79; }
  .course-meta { font-size: 13px; color: #999; margin-top: 4px; }
  .scene { padding: 16px 24px; border-bottom: 1px solid #f0f0f0; }
  .scene:last-child { border-bottom: none; }
  .scene .tag { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; margin-bottom: 8px; }
  .tag-slide { background: #E6F1FB; color: #185FA5; }
  .tag-quiz { background: #EAF3DE; color: #3B6D11; }
  .scene h3 { font-size: 15px; margin-bottom: 8px; }
  .scene p, .scene li { font-size: 14px; line-height: 1.7; color: #555; }
  .quiz-item { background: #FAFAFA; border-radius: 8px; padding: 16px; margin-top: 12px; }
  .quiz-item .q { font-weight: 500; margin-bottom: 8px; }
  .quiz-item .opt { padding: 4px 0; font-size: 13px; }
  .quiz-item .ans { color: #3B6D11; font-weight: 500; margin-top: 6px; }
  .quiz-item .diff { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #FFF3CD; color: #856404; margin-left: 8px; }
  .classroom-link { text-align: center; padding: 20px; background: #F0F7FF; border-radius: 12px; margin-top: 20px; }
  .classroom-link a { color: #2E75B6; font-weight: 500; text-decoration: none; }
  .classroom-link a:hover { text-decoration: underline; }
  .error-msg { color: #A32D2D; background: #FCEBEB; padding: 12px; border-radius: 8px; display: none; }
</style>
</head>
<body>
<div class="header">
  <h1>智慧学习大脑</h1>
  <p>AI 课程生成引擎 — 输入主题，一分钟生成完整课程</p>
</div>
<div class="container">
  <div class="input-box">
    <textarea id="input" placeholder="请输入课程主题，例如：用Python教小学生做猜数字游戏"></textarea>
    <br>
    <button class="btn" id="generateBtn" onclick="generate()">生成课程</button>
  </div>

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <p>正在生成课程，请稍候（约30秒）...</p>
  </div>

  <div class="error-msg" id="error"></div>

  <div class="result" id="result">
    <div class="course-card" id="courseHeader">
      <div class="course-header">
        <h2 id="courseTitle"></h2>
        <div class="course-meta" id="courseMeta"></div>
      </div>
      <div id="scenes"></div>
    </div>
    <div id="quizzes"></div>
    <div class="classroom-link">
      <a href="${OPENMAIC_URL}" target="_blank">进入课堂模式 \u2192</a>
      <p style="color:#999;font-size:12px;margin-top:4px">在 OpenMAIC 中查看和播放课件</p>
    </div>
  </div>
</div>

<script>
async function generate() {
  const input = document.getElementById('input').value.trim();
  if (!input) { alert('请输入课程主题'); return; }

  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('error').style.display = 'none';
  document.getElementById('generateBtn').disabled = true;

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderResult(data);
  } catch (err) {
    document.getElementById('error').textContent = '生成失败: ' + err.message;
    document.getElementById('error').style.display = 'block';
  } finally {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('generateBtn').disabled = false;
  }
}

function renderResult(data) {
  document.getElementById('courseTitle').textContent = data.courseTitle || '';
  document.getElementById('courseMeta').textContent = data.totalScenes + '个场景 \u00B7 ' + (data.estimatedDuration || '');

  let scenesHtml = '';
  (data.scenes || []).forEach((s, i) => {
    const isQuiz = s.type === 'quiz';
    scenesHtml += \`
      <div class="scene">
        <span class="tag \${isQuiz ? 'tag-quiz' : 'tag-slide'}">\${isQuiz ? '练习' : '讲解'}</span>
        <h3>\${s.order}. \${s.title}</h3>
        <p>\${s.content}</p>
      </div>
    \`;
  });
  document.getElementById('scenes').innerHTML = scenesHtml;

  let quizHtml = '';
  (data.quizzes || []).forEach((q, i) => {
    quizHtml += \`
      <div class="quiz-item">
        <div class="q">\${i+1}. \${q.question} <span class="diff">\${q.difficultyLevel || ''}</span></div>
        \${(q.options || []).map(o => '<div class="opt">' + o.label + '. ' + o.value + '</div>').join('')}
        <div class="ans">\u2705 答案: \${(q.answer || []).join(', ')}</div>
        <div style="font-size:13px;color:#666;margin-top:4px">\${q.analysis || ''}</div>
      </div>
    \`;
  });
  if (quizHtml) {
    document.getElementById('quizzes').innerHTML = '<div class="course-card"><div class="course-header"><h2>练习题</h2></div>' + quizHtml + '</div>';
  }

  document.getElementById('result').style.display = 'block';
}
</script>
</body>
</html>`;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API: generate course
  if (pathname === '/api/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { input } = JSON.parse(body);
        if (!input) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '请输入课程主题' }));
        }
        const result = await runPipeline(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Serve main page
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getIndexHTML());
    return;
  }

  // Serve static files
  const filePath = path.join(__dirname, pathname === '/pipeline.js' ? 'pipeline.js' : pathname);
  if (fs.existsSync(filePath)) {
    serveFile(res, filePath);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 智慧学习大脑已启动!`);
  console.log(`   打开 http://localhost:${PORT}`);
  console.log(`   输入课程主题，体验 AI 课程生成\n`);
});
