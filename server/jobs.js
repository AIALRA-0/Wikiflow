// jobs.js - 内存中的 Wiki 提交任务队列（重启后丢失）
'use strict';

const crypto = require('crypto');

const jobs = new Map(); // id -> { userId, status, progress, message, url }

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  jobs,
  newJobId,
};
