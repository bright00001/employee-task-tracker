const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3456;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'docs')));

// Database
const DB_DIR = 'H:\\跨境业务系统数据库';
const db = new Database(path.join(DB_DIR, 'tasks.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 5,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee TEXT NOT NULL,
    date TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    completed INTEGER DEFAULT 0,
    UNIQUE(employee, date, task_id)
  );
  CREATE TABLE IF NOT EXISTS employees (
    name TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Seed defaults if empty
const empCount = db.prepare('SELECT COUNT(*) as cnt FROM employees').get().cnt;
if (empCount === 0) {
  db.prepare("INSERT INTO employees (name) VALUES ('张三'), ('李四')").run();
  const seedTasks = [
    { name: '完成日报', score: 5 },
    { name: '处理客户需求', score: 10 },
    { name: '代码开发与测试', score: 15 },
    { name: '会议参与', score: 5 },
    { name: '文档编写', score: 8 },
  ];
  const insert = db.prepare('INSERT INTO tasks (name, score, sort_order) VALUES (?, ?, ?)');
  seedTasks.forEach((t, i) => insert.run(t.name, t.score, i));
}

// ==================== TASKS ====================
app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare('SELECT id, name, score FROM tasks WHERE active = 1 ORDER BY sort_order, id').all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { name, score } = req.body;
  if (!name || !score) return res.status(400).json({ error: '缺少参数' });
  const maxSort = db.prepare('SELECT MAX(sort_order) as mx FROM tasks').get().mx || 0;
  const result = db.prepare('INSERT INTO tasks (name, score, sort_order) VALUES (?, ?, ?)').run(name, score, maxSort + 1);
  res.json({ id: result.lastInsertRowid, name, score });
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  // Soft delete: set active = 0, also remove associated records
  db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(id);
  db.prepare('DELETE FROM records WHERE task_id = ?').run(id);
  res.json({ success: true });
});

app.put('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const { name, score } = req.body;
  if (name !== undefined) db.prepare('UPDATE tasks SET name = ? WHERE id = ?').run(name, id);
  if (score !== undefined) db.prepare('UPDATE tasks SET score = ? WHERE id = ?').run(score, id);
  res.json({ success: true });
});

// ==================== EMPLOYEES ====================
app.get('/api/employees', (req, res) => {
  const emps = db.prepare('SELECT name FROM employees ORDER BY created_at').all();
  res.json(emps.map(e => e.name));
});

app.post('/api/employees', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '缺少姓名' });
  try {
    db.prepare('INSERT INTO employees (name) VALUES (?)').run(name);
    res.json({ name });
  } catch (e) {
    res.status(400).json({ error: '员工已存在' });
  }
});

app.delete('/api/employees/:name', (req, res) => {
  const { name } = req.params;
  const count = db.prepare('SELECT COUNT(*) as cnt FROM employees').get().cnt;
  if (count <= 1) return res.status(400).json({ error: '至少保留一个员工' });
  db.prepare('DELETE FROM employees WHERE name = ?').run(name);
  db.prepare('DELETE FROM records WHERE employee = ?').run(name);
  res.json({ success: true });
});

// ==================== RECORDS ====================
app.get('/api/records/:date', (req, res) => {
  const { date } = req.params;
  const employees = db.prepare('SELECT name FROM employees ORDER BY created_at').all();
  const tasks = db.prepare('SELECT id, name, score FROM tasks WHERE active = 1 ORDER BY sort_order, id').all();
  
  const result = employees.map(emp => {
    const records = db.prepare('SELECT task_id, completed FROM records WHERE employee = ? AND date = ?').all(emp.name, date);
    const recordMap = {};
    records.forEach(r => { recordMap[r.task_id] = r.completed; });
    
    const taskRecords = tasks.map(t => ({
      taskId: t.id,
      name: t.name,
      score: t.score,
      completed: !!recordMap[t.id]
    }));
    
    const totalScore = tasks.reduce((s, t) => s + t.score, 0);
    const earned = taskRecords.reduce((s, t) => s + (t.completed ? t.score : 0), 0);
    
    return {
      employee: emp.name,
      tasks: taskRecords,
      totalScore,
      earned,
      completedCount: taskRecords.filter(t => t.completed).length,
      totalCount: tasks.length
    };
  });
  
  res.json(result);
});

app.post('/api/records/:date/toggle', (req, res) => {
  const { date } = req.params;
  const { employee, taskId } = req.body;
  if (!employee || !taskId) return res.status(400).json({ error: '缺少参数' });
  
  const existing = db.prepare('SELECT id, completed FROM records WHERE employee = ? AND date = ? AND task_id = ?').get(employee, date, taskId);
  
  if (existing) {
    const newVal = existing.completed ? 0 : 1;
    db.prepare('UPDATE records SET completed = ? WHERE id = ?').run(newVal, existing.id);
    res.json({ completed: !!newVal });
  } else {
    db.prepare('INSERT INTO records (employee, date, task_id, completed) VALUES (?, ?, ?, 1)').run(employee, date, taskId);
    res.json({ completed: true });
  }
});

// ==================== DASHBOARD ====================
app.get('/api/dashboard', (req, res) => {
  const employees = db.prepare('SELECT name FROM employees ORDER BY created_at').all();
  const tasks = db.prepare('SELECT id, name, score FROM tasks WHERE active = 1 ORDER BY sort_order, id').all();
  const today = new Date().toISOString().slice(0, 10);
  const totalPerTask = tasks.reduce((s, t) => s + t.score, 0);

  // This week
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);
  const mondayStr = monday.toISOString().slice(0, 10);

  // This month
  const monthStart = today.slice(0, 7) + '-01';

  // All dates with records
  const allDates = db.prepare('SELECT DISTINCT date FROM records ORDER BY date').all().map(r => r.date);

  const empDashboards = employees.map(emp => {
    // Today
    const todayRecords = db.prepare('SELECT task_id FROM records WHERE employee = ? AND date = ? AND completed = 1').all(emp.name, today);
    const todayCompleted = new Set(todayRecords.map(r => r.task_id));
    const todayEarned = tasks.reduce((s, t) => s + (todayCompleted.has(t.id) ? t.score : 0), 0);

    // Week
    const weekRecords = db.prepare(
      'SELECT date, task_id FROM records WHERE employee = ? AND date >= ? AND completed = 1'
    ).all(emp.name, mondayStr);
    let weekEarned = 0;
    weekRecords.forEach(r => {
      const task = tasks.find(t => t.id === r.task_id);
      if (task) weekEarned += task.score;
    });

    // Month
    const monthRecords = db.prepare(
      'SELECT task_id FROM records WHERE employee = ? AND date >= ? AND completed = 1'
    ).all(emp.name, monthStart);
    let monthEarned = 0;
    monthRecords.forEach(r => {
      const task = tasks.find(t => t.id === r.task_id);
      if (task) monthEarned += task.score;
    });

    // Total
    const allRecords = db.prepare(
      'SELECT task_id FROM records WHERE employee = ? AND completed = 1'
    ).all(emp.name);
    let totalEarned = 0;
    allRecords.forEach(r => {
      const task = tasks.find(t => t.id === r.task_id);
      if (task) totalEarned += task.score;
    });

    // Days with records
    const empDates = db.prepare('SELECT DISTINCT date FROM records WHERE employee = ? ORDER BY date').all(emp.name).map(r => r.date);
    const totalDays = empDates.length;

    // Per-task stats
    const taskStats = tasks.map(t => {
      const count = db.prepare('SELECT COUNT(*) as cnt FROM records WHERE employee = ? AND task_id = ? AND completed = 1').get(emp.name, t.id).cnt;
      return {
        taskId: t.id,
        name: t.name,
        score: t.score,
        completedCount: count,
        totalScore: count * t.score
      };
    });

    // Last 7 days trend
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const dayRecs = db.prepare('SELECT task_id FROM records WHERE employee = ? AND date = ? AND completed = 1').all(emp.name, ds);
      const dayTaskIds = new Set(dayRecs.map(r => r.task_id));
      const earned = tasks.reduce((s, t) => s + (dayTaskIds.has(t.id) ? t.score : 0), 0);
      trend.push({ date: ds, earned });
    }

    return {
      employee: emp.name,
      todayEarned,
      todayCompleted: todayRecords.length,
      todayTotal: tasks.length,
      weekEarned,
      monthEarned,
      totalEarned,
      totalDays,
      avgDaily: totalDays > 0 ? Math.round(totalEarned / totalDays) : 0,
      taskStats,
      trend,
      allEmpDates: empDates
    };
  });

  res.json({
    tasks,
    totalPerTask,
    employees: empDashboards,
    allDates
  });
});

// ==================== HISTORY ====================
app.get('/api/history/:employee', (req, res) => {
  const { employee } = req.params;
  const dates = db.prepare('SELECT DISTINCT date FROM records WHERE employee = ? ORDER BY date DESC').all(employee).map(r => r.date);
  const tasks = db.prepare('SELECT id, name, score FROM tasks WHERE active = 1 ORDER BY sort_order, id').all();
  const totalPerTask = tasks.reduce((s, t) => s + t.score, 0);

  const history = dates.map(date => {
    const recs = db.prepare('SELECT task_id, completed FROM records WHERE employee = ? AND date = ?').all(employee, date);
    const recordMap = {};
    recs.forEach(r => { recordMap[r.task_id] = r.completed; });
    const earned = tasks.reduce((s, t) => s + (recordMap[t.id] ? t.score : 0), 0);
    const completed = tasks.filter(t => recordMap[t.id]).length;
    return {
      date,
      earned,
      completed,
      total: tasks.length,
      pct: totalPerTask > 0 ? Math.round(earned / totalPerTask * 100) : 0
    };
  });

  res.json({ history, tasks, totalPerTask });
});

// ==================== RESET TODAY ====================
app.post('/api/reset-today', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { employee } = req.body;
  if (employee) {
    db.prepare('DELETE FROM records WHERE employee = ? AND date = ?').run(employee, today);
  } else {
    db.prepare('DELETE FROM records WHERE date = ?').run(today);
  }
  res.json({ success: true });
});

// Fallback to index.html for SPA-style routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      resolve(server);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(err);
      } else {
        reject(err);
      }
    });
  });
}

async function main() {
  try {
    const server = await startServer(PORT);
    const os = require('os');
    const nets = os.networkInterfaces();
    console.log('\n✅ 服务器已启动！');
    console.log('━'.repeat(50));
    console.log(`  本机访问: http://localhost:${PORT}`);
    
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  局域网访问: http://${net.address}:${PORT}`);
        }
      }
    }
    console.log('━'.repeat(50));
    console.log('  数据存储: H:\\跨境业务系统数据库\\tasks.db (SQLite)');
    console.log('  按 Ctrl+C 停止服务器\n');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${PORT} 已被占用，尝试端口 ${parseInt(PORT) + 1}...`);
      // Try next port
      const newPort = parseInt(PORT) + 1;
      try {
        const server = await startServer(newPort);
        const os = require('os');
        const nets = os.networkInterfaces();
        console.log('\n✅ 服务器已启动！');
        console.log('━'.repeat(50));
        console.log(`  本机访问: http://localhost:${newPort}`);
        for (const name of Object.keys(nets)) {
          for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
              console.log(`  局域网访问: http://${net.address}:${newPort}`);
            }
          }
        }
        console.log('━'.repeat(50));
        console.log('  按 Ctrl+C 停止服务器\n');
      } catch (e) {
        console.error('❌ 启动失败:', e.message);
        process.exit(1);
      }
    } else {
      console.error('❌ 启动失败:', err.message);
      process.exit(1);
    }
  }
}

main();
