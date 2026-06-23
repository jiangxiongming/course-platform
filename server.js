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

const PORT = process.env.PORT || 3000;
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

// Pipeline.js 直接加载（不用 exec，更稳定）
const { runPipeline } = require('./pipeline.js');

// ══════════════════════════════════════════
// 访问令牌保护（防止 API 被滥用）
// 在 Zeabur 环境变量中设置 ACCESS_TOKEN
// 网页前端调用时自动带令牌，用户无感知
// ══════════════════════════════════════════

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

function checkToken(req, res) {
  if (!ACCESS_TOKEN) return true; // 没设令牌就不校验
  const token = req.headers['x-token'] || parsedQueryToken(req);
  if (token === ACCESS_TOKEN) return true;
  if (req.url.startsWith('/api/')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未授权访问，请提供有效令牌' }));
    return false;
  }
  return true;
}

function parsedQueryToken(req) {
  const u = require('url').parse(req.url, true);
  return u.query.token || '';
}

// 通用 AI 调用（DeepSeek API）
async function callAI(systemPrompt, userInput) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key === 'sk-your-api-key-here') {
    throw new Error('请设置环境变量 DEEPSEEK_API_KEY');
  }
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ], temperature: 0.7, max_tokens: 2048 })
  });
  if (!response.ok) throw new Error(`API错误: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// ══════════════════════════════════════════
// AI 家教讲题 Prompt
// ══════════════════════════════════════════

const PROMPT_TUTOR = `你是AI智能家教老师，专门为中国K12学生提供学科辅导。

教学原则：
1. 深入浅出 — 用生活化例子解释抽象概念
2. 互动式教学 — 讲完主动提问验证理解
3. 根据学生年级调整讲解深度
4. 学生说"听不懂"立即换一种方式

讲解格式：
📚 [标题] → 🎯 核心要点 → 💡 理解方法 → ❓ 思考问题 → 📝 练习

题目讲解格式：
📝 原题 → 💭 解题思路 → ✨ 关键点 → ⚠️ 易错点 → 📌 举一反三

每次讲完必须出1-2道练习题。先了解学生信息，再针对性讲解。`;

// ══════════════════════════════════════════
// 生成试卷 Prompt
// ══════════════════════════════════════════

const PROMPT_PAPER = `你是一个出卷老师。根据用户指定的年级、学科生成一张模拟试卷。

要求：
1. 试卷包含 10 道题：选择题 5 道 + 填空题 3 道 + 解答题 2 道
2. 难度分布：基础 40% + 中等 40% + 提高 20%
3. 标注每道题的分值和难度
4. 附参考答案和评分标准

输出格式（严格JSON）：
{
  "title": "试卷标题",
  "grade": "年级",
  "subject": "学科",
  "totalScore": 100,
  "questions": [
    { "type": "choice"|"fill"|"essay", "difficulty": "基础"|"中等"|"提高", "score": 5,
      "question": "题目内容",
      "options": ["A. xxx","B. xxx"],  // 选择题才有
      "answer": "答案",
      "analysis": "解析" }
  ]
}`;

// POST /api/paper 处理函数
async function handlePaper(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { grade, subject, count = 10 } = JSON.parse(body);
      if (!grade || !subject) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '请指定年级和学科' }));
      }
      const input = `年级：${grade}\n学科：${subject}\n题数：${count}题`;
      const result = await callAI(PROMPT_PAPER, input);
      // 尝试提取 JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(JSON.parse(jsonMatch[0])));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: result }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// API: 讲题（直接调 AI，不经过 pipeline）
async function handleTutor(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { question, grade, subject } = JSON.parse(body);
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '请输入题目' }));
      }
      const input = `学生年级：${grade || '未指定'}\n学科：${subject || '未指定'}\n题目/问题：${question}`;
      const result = await callAI(PROMPT_TUTOR, input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// HTML pages
function getIndexHTML() {
  const defaultCode = 'zfx2026';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 智慧课堂</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .gate-box { background: white; border-radius: 20px; padding: 40px; width: 400px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; }
  .gate-box h1 { font-size: 22px; color: #1a365d; margin-bottom: 8px; }
  .gate-box p { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
  .gate-box input { display: block; width: 100%; padding: 14px 16px; border: 2px solid #e5e7eb; border-radius: 12px; font-size: 16px; text-align: center; font-family: inherit; outline: none; transition: border-color 0.2s; }
  .gate-box input:focus { border-color: #667eea; }
  .gate-box .btn-gate { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; padding: 12px 0; width: 100%; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 16px; transition: transform 0.15s; }
  .gate-box .btn-gate:hover { transform: translateY(-1px); }
  .gate-box .error-msg { color: #dc2626; font-size: 13px; margin-top: 12px; display: none; }
  .app-container { display: none; }
</style>
</head>
<body>
<div class="gate-box" id="gate">
  <h1>🔐 AI 智慧课堂</h1>
  <p>请输入访问密码</p>
  <input type="password" id="accessCode" placeholder="请输入密码" onkeydown="if(event.key==='Enter')checkCode()" autofocus>
  <button class="btn-gate" onclick="checkCode()">进入</button>
  <div class="error-msg" id="gateError"></div>
</div>

<script>
function checkCode() {
  const code = document.getElementById('accessCode').value.trim();
  if (code === '${defaultCode}') {
    localStorage.setItem('ai_access_granted', 'true');
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
  } else {
    document.getElementById('gateError').textContent = '密码错误，请重新输入';
    document.getElementById('gateError').style.display = 'block';
  }
}
// 已经验证过的直接跳过
if (localStorage.getItem('ai_access_granted') === 'true') {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}
</script>

<div class="app-container" id="app">

<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #f0f4ff 0%, #fbe8e8 50%, #f0f4ff 100%); color: #333; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1a365d 0%, #2563eb 50%, #1d4ed8 100%); color: white; padding: 32px 40px; position: relative; overflow: hidden; }
  .header::before { content: ''; position: absolute; top: -50%; right: -20%; width: 400px; height: 400px; background: rgba(255,255,255,0.05); border-radius: 50%; }
  .header::after { content: ''; position: absolute; bottom: -30%; left: -10%; width: 300px; height: 300px; background: rgba(255,255,255,0.03); border-radius: 50%; }
  .header h1 { font-size: 28px; font-weight: 700; position: relative; z-index: 1; letter-spacing: 1px; }
  .header p { font-size: 15px; opacity: 0.85; margin-top: 6px; position: relative; z-index: 1; }
  .container { max-width: 900px; margin: 0 auto; padding: 28px 24px; }
  .input-box { background: white; border-radius: 16px; padding: 28px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); margin-bottom: 20px; border: 1px solid rgba(0,0,0,0.04); }
  .input-box textarea { width: 100%; min-height: 90px; padding: 14px 16px; border: 2px solid #e5e7eb; border-radius: 12px; font-size: 15px; resize: vertical; transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit; }
  .input-box textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,0.1); }
  .btn { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; border: none; padding: 12px 32px; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 14px; transition: transform 0.15s, box-shadow 0.2s; box-shadow: 0 4px 12px rgba(37,99,235,0.3); letter-spacing: 0.5px; }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(37,99,235,0.4); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { background: #9ca3af; box-shadow: none; cursor: not-allowed; transform: none; }
  .btn-green { background: linear-gradient(135deg, #059669, #047857); box-shadow: 0 4px 12px rgba(5,150,105,0.3); }
  .btn-green:hover { box-shadow: 0 6px 20px rgba(5,150,105,0.4); }
  .loading { display: none; text-align: center; padding: 50px 40px; color: #6b7280; }
  .loading .spinner { border: 3px solid #e5e7eb; border-top: 3px solid #2563eb; border-radius: 50%; width: 36px; height: 36px; animation: spin 0.7s linear infinite; margin: 0 auto 14px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading p { font-size: 14px; }
  .result { display: none; }
  .course-card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); margin-bottom: 18px; overflow: hidden; border: 1px solid rgba(0,0,0,0.04); }
  .course-header { padding: 22px 28px; border-bottom: 1px solid #f3f4f6; }
  .course-header h2 { font-size: 20px; color: #1a365d; font-weight: 600; }
  .course-meta { font-size: 13px; color: #9ca3af; margin-top: 4px; }
  .scene { padding: 20px 28px; border-bottom: 1px solid #f9fafb; transition: background 0.15s; }
  .scene:hover { background: #fafbfc; }
  .scene:last-child { border-bottom: none; }
  .scene .tag { display: inline-block; padding: 3px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 10px; letter-spacing: 0.3px; }
  .tag-slide { background: #dbeafe; color: #1d4ed8; }
  .tag-quiz { background: #d1fae5; color: #047857; }
  .scene h3 { font-size: 16px; font-weight: 600; margin-bottom: 10px; color: #1a365d; }
  .scene p, .scene li { font-size: 14px; line-height: 1.8; color: #4b5563; }
  .quiz-item { background: #f9fafb; border-radius: 12px; padding: 20px; margin-top: 14px; border: 1px solid #f3f4f6; }
  .quiz-item .q { font-weight: 600; margin-bottom: 10px; color: #1a365d; }
  .quiz-item .opt { padding: 5px 0; font-size: 14px; color: #4b5563; }
  .quiz-item .ans { color: #047857; font-weight: 600; margin-top: 8px; font-size: 14px; }
  .quiz-item .diff { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; background: #fef3c7; color: #92400e; margin-left: 8px; font-weight: 600; }
  .classroom-link { text-align: center; padding: 22px; background: linear-gradient(135deg, #eff6ff, #dbeafe); border-radius: 16px; margin-top: 20px; }
  .classroom-link a { color: #2563eb; font-weight: 600; text-decoration: none; font-size: 15px; }
  .classroom-link a:hover { text-decoration: underline; }
  .error-msg { color: #991b1b; background: #fef2f2; padding: 14px 18px; border-radius: 12px; display: none; font-size: 14px; border: 1px solid #fecaca; }
  .tabs { display: flex; gap: 4px; margin-bottom: 24px; background: white; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.04); }
  .tab { flex: 1; padding: 16px; text-align: center; cursor: pointer; font-size: 15px; font-weight: 500; border: none; background: white; color: #9ca3af; transition: all 0.2s; }
  .tab.active { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; font-weight: 600; }
  .tab:hover:not(.active) { background: #f3f4f6; color: #4b5563; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .tutor-answer { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 28px; line-height: 2; font-size: 15px; white-space: pre-wrap; color: #374151; border: 1px solid rgba(0,0,0,0.04); }
  .form-row { display: flex; gap: 14px; margin-bottom: 14px; }
  .form-row input { flex: 1; padding: 12px 14px; border: 2px solid #e5e7eb; border-radius: 10px; font-size: 14px; transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit; }
  .form-row input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,0.1); }
  @media (max-width: 640px) { .header { padding: 24px 20px; } .header h1 { font-size: 22px; } .container { padding: 16px; } .form-row { flex-direction: column; gap: 10px; } .scene { padding: 16px 20px; } .course-header { padding: 18px 20px; } .input-box { padding: 20px; } }
</style>
</head>
<body>
<div class="header">
  <h1>智慧学习大脑</h1>
  <p>AI 课程生成 + 一对一讲题辅导</p>
</div>
<div class="container">

  <div class="tabs">
    <div class="tab active" onclick="switchTab('course')">生成课程</div>
    <div class="tab" onclick="switchTab('tutor')">AI 讲题</div>
  </div>

  <!-- 生成课程 -->
  <div class="tab-content active" id="tab-course">
    <div class="input-box">
      <textarea id="input" placeholder="请输入课程主题，例如：用Python教小学生做猜数字游戏"></textarea>
      <br>
      <button class="btn" onclick="generate()">生成课程</button>
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

  <!-- AI 讲题 -->
  <div class="tab-content" id="tab-tutor">
    <div class="input-box">
      <div class="form-row">
        <input id="tutorGrade" placeholder="年级（如：三年级）" value="三年级">
        <input id="tutorSubject" placeholder="学科（如：数学）" value="数学">
      </div>
      <textarea id="tutorInput" placeholder="输入题目或学习问题，例如：小明有5个苹果，给了小红2个，还剩几个？" style="min-height:60px"></textarea>
      <br>
      <button class="btn" onclick="askTutor()" style="background:#639922">AI 讲题</button>
    </div>
    <div class="loading" id="tutorLoading">
      <div class="spinner"></div>
      <p>AI 家教正在讲解，请稍候...</p>
    </div>
    <div class="error-msg" id="tutorError"></div>
    <div class="tutor-answer" id="tutorAnswer" style="display:none"></div>
  </div>

</div>

<script>
const API_TOKEN = '${ACCESS_TOKEN}';
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  if (name === 'course') {
    document.querySelector('.tab').classList.add('active');
    document.getElementById('tab-course').classList.add('active');
  } else {
    document.querySelectorAll('.tab')[1].classList.add('active');
    document.getElementById('tab-tutor').classList.add('active');
  }
}

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
      headers: { 'Content-Type': 'application/json', 'x-token': API_TOKEN },
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

async function askTutor() {
  const question = document.getElementById('tutorInput').value.trim();
  const grade = document.getElementById('tutorGrade').value.trim();
  const subject = document.getElementById('tutorSubject').value.trim();
  if (!question) { alert('请输入题目'); return; }

  document.getElementById('tutorLoading').style.display = 'block';
  document.getElementById('tutorAnswer').style.display = 'none';
  document.getElementById('tutorError').style.display = 'none';

  try {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': API_TOKEN },
      body: JSON.stringify({ question, grade, subject })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('tutorAnswer').textContent = data.answer;
    document.getElementById('tutorAnswer').style.display = 'block';
  } catch (err) {
    document.getElementById('tutorError').textContent = '讲题失败: ' + err.message;
    document.getElementById('tutorError').style.display = 'block';
  } finally {
    document.getElementById('tutorLoading').style.display = 'none';
  }
}
</script>
</body>
</html>`;
}

// HTTP server
// 访问日志
const accessLog = [];
function logAccess(req, status) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = (req.headers['user-agent'] || '').substring(0, 60);
  const entry = {
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    ip,
    url: req.url.substring(0, 50),
    status,
    ua,
  };
  accessLog.unshift(entry);
  if (accessLog.length > 200) accessLog.length = 200;
  console.log(`[${entry.time}] ${entry.ip} → ${req.url} (${status})`);
}

// 自动记录所有响应的日志
function wrapResponse(req, res) {
  const origEnd = res.end.bind(res);
  res.end = function(...args) {
    logAccess(req, res.statusCode);
    return origEnd(...args);
  };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  wrapResponse(req, res);

  // Admin 日志页面（需要密码）
  if (pathname === '/admin') {
    const pwd = parsed.query.pwd;
    if (pwd === 'admin2026') {
      const html = `<html><head><meta charset="utf-8"><title>访问日志</title>
        <style>body{font-family:sans-serif;padding:20px;background:#f9fafb}
        table{width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
        th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}
        th{background:#1a365d;color:white;font-weight:600}
        tr:hover{background:#f3f4f6}
        .count{font-size:14px;color:#6b7280;margin-bottom:12px}
        h1{font-size:20px;margin-bottom:8px;color:#1a365d}</style></head>
        <body><h1>📋 访问日志</h1>
        <div class="count">最近 ${accessLog.length} 条记录</div>
        <table><tr><th>时间</th><th>IP</th><th>URL</th><th>状态</th><th>设备</th></tr>
        ${accessLog.slice(0, 100).map(e => `<tr><td>${e.time}</td><td>${e.ip}</td><td>${e.url}</td><td>${e.status}</td><td>${e.ua}</td></tr>`).join('')}
        </table></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(401);
      res.end('密码错误');
    }
    return;
  }

  // 访问令牌校验（API 路由需要令牌，网页不需要）
  if (pathname.startsWith('/api/') && ACCESS_TOKEN) {
    const token = req.headers['x-token'] || parsed.query.token || '';
    if (token !== ACCESS_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权访问' }));
      return;
    }
  }

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

  // API: 讲题（AI 家教）
  if (pathname === '/api/tutor' && req.method === 'POST') {
    return handleTutor(req, res);
  }

  // Serve main page
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getIndexHTML());
    return;
  }

  // API: 生成试卷
  if (pathname === '/api/paper' && req.method === 'POST') {
    return handlePaper(req, res);
  }

  // API: 生成试卷（GET 版，供 WorkBuddy 调用）
  if (pathname === '/api/paper-get' && req.method === 'GET') {
    const grade = parsed.query.grade || '未指定';
    const subject = parsed.query.subject || '未指定';
    const count = parsed.query.count || 10;
    try {
      const input = `年级：${grade}\n学科：${subject}\n题数：${count}题`;
      const result = await callAI(PROMPT_PAPER, input);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(JSON.parse(jsonMatch[0])));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: result }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: 讲题（GET 版，供 WorkBuddy 调用）
  if (pathname === '/api/tutor-get' && req.method === 'GET') {
    const question = parsed.query.question;
    const grade = parsed.query.grade || '未指定';
    const subject = parsed.query.subject || '未指定';
    if (!question) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '缺少 question 参数' }));
    }
    try {
      const input = `学生年级：${grade}\n学科：${subject}\n题目/问题：${decodeURIComponent(question)}`;
      const result = await callAI(PROMPT_TUTOR, input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
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
