require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection (use Atlas URI from env)
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Schema for Logs
const logSchema = new mongoose.Schema({
  uid: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  action: { type: String, required: true },
  details: { type: Object, default: {} },
  date: { type: String, required: true }  // YYYY-MM-DD for queries
});
const Log = mongoose.model('Log', logSchema);

// POST /api/log - Log user action
app.post('/api/log', async (req, res) => {
  try {
    const { uid, action, details = {}, date } = req.body;
    if (!uid || !action || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const newLog = new Log({ uid, action, details, date });
    await newLog.save();
    res.status(201).json({ message: 'Logged successfully' });
  } catch (error) {
    console.error('Log error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/logs - Fetch logs (admin only, with user metrics)
app.get('/api/admin/logs', async (req, res) => {
  const { key, since = '2025-10-05' } = req.query;
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const logs = await Log.find({ date: { $gte: since } }).sort({ timestamp: -1 }).limit(100);
    const uniqueUsers = [...new Set(logs.map(l => l.uid))];
    const totalUsers = uniqueUsers.length;

    // User engagement metrics
    const userLogCounts = logs.reduce((acc, log) => {
      acc[log.uid] = (acc[log.uid] || 0) + 1;
      return acc;
    }, {});
    const oneTimeUsers = Object.values(userLogCounts).filter(count => count === 1).length;
    const repeatUsers = Object.values(userLogCounts).filter(count => count > 1).length;
    // New users: All unique since 'since' date (assuming no pre-data; else query first log per user)
    const newUsers = totalUsers;  // Customize: Query min date per UID if needed

    const actionCounts = logs.reduce((acc, l) => {
      acc[l.action] = (acc[l.action] || 0) + 1;
      return acc;
    }, {});
    const topActions = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([a, count]) => `${a} (${count})`);
    const issues = logs.filter(l => l.action === 'failed_transaction' || l.action === 'user_stuck');

    res.json({
      totalUsers,
      newUsers,
      repeatUsers,
      oneTimeUsers,
      topActions,
      logs,
      issues: issues.slice(0, 10)
    });
  } catch (error) {
    console.error('Admin fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
