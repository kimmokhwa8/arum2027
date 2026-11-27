// 교사·학생 화면이 함께 쓰는 기능
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function api(method, url, body, headers = {}) {
  const opt = { method, headers: { ...headers } };
  if (body instanceof FormData) opt.body = body;
  else if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || '문제가 생겼어요. 잠시 후 다시 해 주세요.');
  return data;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
    return ok;
  }
}

// 탭 전환
function setupTabs(onChange) {
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === b.dataset.panel));
      const badge = b.querySelector('.badge');
      if (badge) badge.remove();
      onChange && onChange(b.dataset.panel);
    });
  });
}
function currentPanel() {
  const a = $('.tab.active');
  return a ? a.dataset.panel : '';
}
function bumpBadge(panelId) {
  if (currentPanel() === panelId) return;
  const tab = document.querySelector(`.tab[data-panel="${panelId}"]`);
  if (!tab) return;
  let b = tab.querySelector('.badge');
  if (!b) { b = el('span', { class: 'badge', text: '0' }); tab.append(b); }
  b.textContent = String(Number(b.textContent) + 1);
}

// ---------- 프롬프트 (학생용: 복사만) ----------
function renderPromptsReadonly(box, prompts) {
  box.replaceChildren();
  if (!prompts.length) {
    box.append(el('div', { class: 'empty' }, el('div', { class: 'emoji', text: '📋' }), el('div', { text: '아직 선생님이 올린 프롬프트가 없어요.' })));
    return;
  }
  prompts.forEach((p, i) => {
    const btn = el('button', { class: 'btn primary copy', text: '📋 복사' });
    btn.addEventListener('click', async () => {
      const ok = await copyText(p.text);
      if (ok) {
        btn.textContent = '✅ 복사됨';
        btn.classList.add('done');
        toast('복사됐어요! 붙여 넣을 곳에서 Ctrl + V 를 눌러요.');
        setTimeout(() => { btn.textContent = '📋 복사'; btn.classList.remove('done'); }, 2500);
      } else {
        toast('복사가 안 됐어요. 글자를 직접 드래그해서 복사해 주세요.');
      }
    });
    box.append(el('div', { class: 'prompt' },
      el('div', { class: 'num', text: String(i + 1) }),
      el('div', { class: 'body' },
        p.title ? el('div', { class: 'title', text: p.title }) : null,
        el('div', { class: 'text', text: p.text })
      ),
      btn
    ));
  });
}

// ---------- 게시판 ----------
function timeText(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return '오늘 ' + hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
function sizeText(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
// 글 속 https 주소는 눌러서 열 수 있게
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(el('a', { href: m[1], target: '_blank', rel: 'noopener noreferrer', text: m[1] }));
    last = m.index + m[1].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function makePostEl(p, canDelete, onDelete) {
  const card = el('div', { class: 'post' + (p.byTeacher ? ' teacher' : ''), 'data-id': p.id });
  const meta = el('div', { class: 'meta' },
    el('span', { class: 'who', text: (p.byTeacher ? '👩‍🏫 ' : '🙂 ') + p.name }),
    el('span', { class: 'when', text: timeText(p.ts) })
  );
  if (canDelete) {
    meta.append(el('button', { class: 'btn small del', text: '지우기', onclick: () => onDelete(p) }));
  }
  card.append(meta);
  if (p.text) { const t = el('div', { class: 'text' }); t.append(linkify(p.text)); card.append(t); }
  if (p.file) {
    if (p.file.image) {
      const img = el('img', { src: p.file.url, alt: p.file.name, loading: 'lazy' });
      img.addEventListener('click', () => window.open(p.file.url, '_blank', 'noopener'));
      card.append(img);
    } else {
      card.append(el('a', { class: 'attach', href: p.file.url, download: p.file.name },
        '📎 ', p.file.name, el('span', { class: 'muted', text: ' (' + sizeText(p.file.size) + ')' })));
    }
  }
  return card;
}

// 게시판 한 덩어리를 만들어 주는 함수
// opts: { code, getName, teacherKey, myPosts(Set), onMyPostsChange }
function createBoard(root, opts) {
  const list = el('div', { class: 'posts' });
  const textArea = el('textarea', { placeholder: '여기에 글을 써요. 링크(https://...)를 붙여 넣어도 돼요.', maxlength: '3000' });
  const fileInput = el('input', { type: 'file' });
  const fileName = el('span', { class: 'file-name', text: '선택한 파일 없음' });
  const sendBtn = el('button', { class: 'btn primary big', text: '올리기' });
  const clearBtn = opts.teacherKey ? el('button', { class: 'btn danger small', text: '게시판 전체 지우기' }) : null;

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileName.textContent = f ? `${f.name} (${sizeText(f.size)})` : '선택한 파일 없음';
    if (f && f.size > 10 * 1024 * 1024) { toast('파일은 10MB까지 올릴 수 있어요.'); fileInput.value = ''; fileName.textContent = '선택한 파일 없음'; }
  });

  root.replaceChildren(
    el('div', { class: 'card compose' },
      el('div', { style: 'font-weight:800;font-size:19px;margin-bottom:8px', text: '✏️ 게시판에 올리기' }),
      textArea,
      el('div', { class: 'row' },
        el('label', { class: 'btn file-pick' }, '📎 파일·사진 고르기', fileInput),
        fileName,
        el('span', { style: 'flex:1' }),
        clearBtn,
        sendBtn
      )
    ),
    list
  );

  let posts = [];
  const canDelete = (p) => !!opts.teacherKey || opts.myPosts.has(p.id);

  async function del(p) {
    if (!confirm('이 글을 지울까요?')) return;
    try {
      const h = {};
      if (opts.teacherKey) h['x-teacher-key'] = opts.teacherKey;
      const mine = store.get('owner-key');
      if (mine) h['x-owner-key'] = mine;
      await api('DELETE', `/api/room/${opts.code()}/posts/${p.id}`, null, h);
    } catch (e) { toast(e.message); }
  }

  function render() {
    list.replaceChildren();
    if (!posts.length) {
      list.append(el('div', { class: 'empty', style: 'column-span:all' }, el('div', { class: 'emoji', text: '📁' }), el('div', { text: '아직 올라온 글이 없어요.' })));
      return;
    }
    posts.forEach((p) => list.append(makePostEl(p, canDelete(p), del)));
  }

  sendBtn.addEventListener('click', async () => {
    const text = textArea.value.trim();
    const f = fileInput.files[0];
    if (!text && !f) { toast('글을 쓰거나 파일을 골라 주세요.'); return; }
    const fd = new FormData();
    fd.append('text', text);
    fd.append('name', opts.getName ? opts.getName() : '');
    let owner = store.get('owner-key');
    if (!owner) { owner = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('owner-key', owner); }
    fd.append('ownerKey', owner);
    if (f) fd.append('file', f);
    sendBtn.disabled = true;
    sendBtn.textContent = '올리는 중…';
    try {
      const h = opts.teacherKey ? { 'x-teacher-key': opts.teacherKey } : {};
      const r = await api('POST', `/api/room/${opts.code()}/posts`, fd, h);
      opts.myPosts.add(r.post.id);
      opts.onMyPostsChange && opts.onMyPostsChange();
      textArea.value = '';
      fileInput.value = '';
      fileName.textContent = '선택한 파일 없음';
      toast('올렸어요!');
      if (!posts.find((x) => x.id === r.post.id)) posts.unshift(r.post);
      render(); // 내 글에 [지우기] 버튼이 보이도록 다시 그림
    } catch (e) {
      toast(e.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '올리기';
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('게시판의 글과 파일을 모두 지울까요? 되돌릴 수 없어요.')) return;
      try { await api('DELETE', `/api/room/${opts.code()}/posts`, null, { 'x-teacher-key': opts.teacherKey }); }
      catch (e) { toast(e.message); }
    });
  }

  render();
  return {
    setAll(arr) { posts = arr.slice(); render(); },
    add(p) { if (!posts.find((x) => x.id === p.id)) { posts.unshift(p); render(); return true; } return false; },
    remove(id) { posts = posts.filter((x) => x.id !== id); render(); },
    clear() { posts = []; render(); }
  };
}

// 화면 공유 연결 설정 (같은 학교 망에서는 대부분 STUN만으로 연결돼요)
const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};
