// 우리 반 교실 — 화면 공유 + 프롬프트 복사 + 자료 게시판
// 실행: npm install → npm start (기본 주소 http://localhost:3000)
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_FILE_MB = 10;
const MAX_POSTS = 300;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 저장 ----------
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { rooms = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, JSON.stringify(rooms), () => {});
  }, 300);
}

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
function newCode() {
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms[c]);
  return c;
}
function makeRoom(code, key) {
  rooms[code] = { code, teacherKey: key, prompts: [], posts: [], createdAt: Date.now() };
  save();
  return rooms[code];
}
const publicPost = (p) => ({ id: p.id, name: p.name, text: p.text, file: p.file, ts: p.ts, byTeacher: !!p.byTeacher });
const publicState = (room) => ({ prompts: room.prompts, posts: room.posts.map(publicPost) });
const isTeacher = (room, key) => !!room && typeof key === 'string' && key.length > 0 && key === room.teacherKey;
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);

// ---------- 웹 서버 ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// 업로드 파일: 사진은 바로 보이고, 나머지는 내려받기로만 열림
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!IMG_EXT.has(ext)) res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  }
}));

// 교실 만들기 / 다시 열기
app.post('/api/room', (req, res) => {
  const { code, teacherKey } = req.body || {};
  if (code && teacherKey && /^\d{6}$/.test(code)) {
    const room = rooms[code];
    if (room && room.teacherKey === teacherKey) return res.json({ code, teacherKey, state: publicState(room) });
    if (!room) { // 서버가 재시작되어 교실이 사라진 경우 같은 코드로 다시 만듦
      const r = makeRoom(code, teacherKey);
      return res.json({ code, teacherKey, state: publicState(r), recreated: true });
    }
  }
  const c = newCode();
  const k = rid(16);
  const r = makeRoom(c, k);
  res.json({ code: c, teacherKey: k, state: publicState(r), created: true });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '교실 코드를 찾을 수 없어요.' });
  res.json({ ok: true, state: publicState(room) });
});

// 프롬프트 (교사만 수정)
app.put('/api/room/:code/prompts', (req, res) => {
  const room = rooms[req.params.code];
  if (!isTeacher(room, req.get('x-teacher-key'))) return res.status(403).json({ error: '선생님만 바꿀 수 있어요.' });
  const list = Array.isArray(req.body && req.body.prompts) ? req.body.prompts : [];
  room.prompts = list.slice(0, 100).map((p) => ({
    id: clean(p.id, 40) || rid(6),
    title: clean(p.title, 100),
    text: clean(p.text, 5000)
  })).filter((p) => p.text.trim());
  save();
  io.to(room.code).emit('prompts', room.prompts);
  res.json({ ok: true, prompts: room.prompts });
});

// 게시판 글 올리기 (모두)
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, Date.now() + '-' + rid(6) + ext);
    }
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 }
});

app.post('/api/room/:code/posts', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `파일은 ${MAX_FILE_MB}MB까지 올릴 수 있어요.` : '파일을 올리지 못했어요.';
      return res.status(400).json({ error: msg });
    }
    const room = rooms[req.params.code];
    if (!room) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: '교실 코드를 찾을 수 없어요.' });
    }
    const text = clean(req.body.text, 3000);
    if (!text.trim() && !req.file) return res.status(400).json({ error: '글을 쓰거나 파일을 골라 주세요.' });
    const byTeacher = isTeacher(room, req.get('x-teacher-key'));
    let file = null;
    if (req.file) {
      // 브라우저가 보낸 파일 이름은 latin1로 들어오므로 한글 복원
      let original = req.file.originalname || 'file';
      try { original = Buffer.from(original, 'latin1').toString('utf8'); } catch (e) {}
      const ext = path.extname(req.file.filename).toLowerCase();
      file = {
        url: '/uploads/' + req.file.filename,
        name: clean(original, 120),
        size: req.file.size,
        image: IMG_EXT.has(ext)
      };
    }
    const post = {
      id: rid(6),
      name: byTeacher ? '선생님' : (clean(req.body.name, 20).trim() || '이름 없음'),
      text,
      file,
      ts: Date.now(),
      byTeacher,
      ownerKey: clean(req.body.ownerKey, 64)
    };
    room.posts.unshift(post);
    // 너무 많아지면 오래된 글부터 정리
    while (room.posts.length > MAX_POSTS) {
      const old = room.posts.pop();
      if (old.file) fs.unlink(path.join(UPLOAD_DIR, path.basename(old.file.url)), () => {});
    }
    save();
    io.to(room.code).emit('post-added', publicPost(post));
    res.json({ ok: true, post: publicPost(post) });
  });
});

function removePost(room, id) {
  const i = room.posts.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const [p] = room.posts.splice(i, 1);
  if (p.file) fs.unlink(path.join(UPLOAD_DIR, path.basename(p.file.url)), () => {});
  return true;
}

app.delete('/api/room/:code/posts/:id', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) return res.status(404).json({ error: '교실 코드를 찾을 수 없어요.' });
  const post = room.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '이미 지워진 글이에요.' });
  const owner = req.get('x-owner-key');
  const allowed = isTeacher(room, req.get('x-teacher-key')) || (owner && post.ownerKey && owner === post.ownerKey);
  if (!allowed) return res.status(403).json({ error: '내가 쓴 글만 지울 수 있어요.' });
  removePost(room, post.id);
  save();
  io.to(room.code).emit('post-removed', post.id);
  res.json({ ok: true });
});

app.delete('/api/room/:code/posts', (req, res) => {
  const room = rooms[req.params.code];
  if (!isTeacher(room, req.get('x-teacher-key'))) return res.status(403).json({ error: '선생님만 할 수 있어요.' });
  [...room.posts].forEach((p) => removePost(room, p.id));
  save();
  io.to(room.code).emit('posts-cleared');
  res.json({ ok: true });
});

// ---------- 실시간 (화면 공유 연결) ----------
const live = {}; // code -> { teacherId, teachers: Set, students: Map(socketId -> {name, joinedAt, sharing}) }
const liveOf = (code) => (live[code] = live[code] || { teacherId: null, teachers: new Set(), students: new Map() });
const MAX_FRAME = 400 * 1024; // 화면 사진 한 장 최대 크기
const studentList = (L) => [...L.students.entries()].map(([id, s]) => ({ id, ...s }));

io.on('connection', (socket) => {
  socket.on('join', (msg, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = clean(msg && msg.code, 6);
    const room = rooms[code];
    if (!room) return ack({ error: '교실 코드를 찾을 수 없어요. 선생님께 코드를 다시 확인해 주세요.' });
    const L = liveOf(code);

    if (msg.role === 'teacher') {
      if (!isTeacher(room, msg.teacherKey)) return ack({ error: '선생님 확인에 실패했어요.' });
      socket.data = { code, role: 'teacher' };
      socket.join(code);
      socket.join(code + ':t'); // 학생 화면 사진을 받는 선생님 전용 방
      L.teachers.add(socket.id);
      L.teacherId = socket.id;
      socket.to(code).emit('teacher-online', { teacherId: socket.id });
      return ack({ ok: true, students: studentList(L), state: publicState(room) });
    }

    const name = clean(msg.name, 20).trim();
    if (!name) return ack({ error: '이름을 써 주세요.' });
    socket.data = { code, role: 'student', name };
    socket.join(code);
    const s = { name, joinedAt: Date.now(), sharing: false };
    L.students.set(socket.id, s);
    io.to(code + ':t').emit('student-joined', { id: socket.id, ...s });
    ack({ ok: true, teacherId: L.teacherId, state: publicState(room) });
  });

  // WebRTC 신호 전달: 학생 ↔ 선생님 사이에서만
  socket.on('signal', (msg) => {
    const d = socket.data || {};
    if (!d.code || !msg || typeof msg.to !== 'string') return;
    const L = liveOf(d.code);
    const ok = d.role === 'student' ? msg.to === L.teacherId : L.students.has(msg.to);
    if (!ok) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  socket.on('share-state', (sharing) => {
    const d = socket.data || {};
    if (d.role !== 'student') return;
    const L = liveOf(d.code);
    const s = L.students.get(socket.id);
    if (!s) return;
    s.sharing = !!sharing;
    io.to(d.code + ':t').emit('student-state', { id: socket.id, sharing: s.sharing });
  });

  // 직접 연결이 막힌 학교망에서는 학생 화면을 사진으로 찍어 서버를 거쳐 보냄
  socket.on('frame', (buf) => {
    const d = socket.data || {};
    if (d.role !== 'student') return;
    if (!buf || !(buf instanceof Buffer) || buf.length > MAX_FRAME) return;
    const L = liveOf(d.code);
    const s = L.students.get(socket.id);
    if (!s) return;
    if (!s.sharing) { s.sharing = true; io.to(d.code + ':t').emit('student-state', { id: socket.id, sharing: true }); }
    io.to(d.code + ':t').volatile.emit('frame', { id: socket.id, buf });
  });

  socket.on('end-all', () => {
    const d = socket.data || {};
    if (d.role !== 'teacher') return;
    socket.to(d.code).emit('end-share');
  });

  socket.on('send-link', (url) => {
    const d = socket.data || {};
    if (d.role !== 'teacher') return;
    const u = clean(url, 2000).trim();
    if (!/^https?:\/\//i.test(u)) return;
    socket.to(d.code).emit('link', { url: u, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    const d = socket.data || {};
    if (!d.code) return;
    const L = liveOf(d.code);
    if (d.role === 'student') {
      L.students.delete(socket.id);
      io.to(d.code + ':t').emit('student-left', { id: socket.id });
    } else if (d.role === 'teacher') {
      L.teachers.delete(socket.id);
      if (L.teacherId === socket.id) {
        // 다른 선생님 창이 열려 있으면 그 창이 이어받음
        const rest = [...L.teachers];
        L.teacherId = rest.length ? rest[rest.length - 1] : null;
        if (L.teacherId) socket.to(d.code).emit('teacher-online', { teacherId: L.teacherId });
        else socket.to(d.code).emit('teacher-offline');
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`우리 반 교실 서버가 켜졌어요: http://localhost:${PORT}`);
});
