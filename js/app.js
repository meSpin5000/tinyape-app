// Quote an ID for use in inline onclick handlers.
// Integer IDs work bare, but UUID strings need quotes to be valid JS.
function qid(id) { return typeof id === 'string' ? `'${id}'` : id; }

// ─── DATA STORE ───
const store = {
  tasks: [],
  projects: [],
  nextId: 1,
  killedTasks: [],
  selectedRecurring: null,
  selectedRecurDays: [],
  selectedDueDate: null,
  drawerOpen: false,
  drawerCatFilter: null,
  drawerCategories: {},
  addTaskAsProject: false,
  addTaskTrackTime: false,
};

const categories = {
  work:     { label: "Work",     color: "#2456a4" },
  personal: { label: "Personal", color: "#2a7d4f" },
  creative: { label: "Creative", color: "#9b59b6" },
  admin:    { label: "Admin",    color: "#b8860b" },
};

// ─── API LAYER (clean separation for future agentic use) ───
const api = {
  getTodayTasks() {
    return store.tasks
      .filter(t => t.today && !t.done)
      .sort((a, b) => a.todayOrder - b.todayOrder);
  },
  getDoneTasks() {
    return store.tasks.filter(t => t.done);
  },
  getProjectTasks() {
    return store.tasks
      .filter(t => t.isProject && !t.today && !t.done && !t.drawer)
      .sort((a, b) => {
        // Sort by user-defined projectOrder first, then by due date
        const ao = a.projectOrder != null ? a.projectOrder : 9999;
        const bo = b.projectOrder != null ? b.projectOrder : 9999;
        if (ao !== bo) return ao - bo;
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        return 0;
      });
  },
  reorderProjects(orderedIds) {
    orderedIds.forEach((id, i) => {
      const task = store.tasks.find(t => t.id === id);
      if (task) task.projectOrder = i + 1;
    });
  },
  getBacklogTasks() {
    return store.tasks
      .filter(t => !t.today && !t.done && !t.drawer && !t.isProject)
      .sort((a, b) => {
        // Tasks with due dates first, sorted soonest-first; no date goes to bottom
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        return 0;
      });
  },
  getAllTasks() {
    return store.tasks.filter(t => !t.done);
  },
  getTasksByCategory(cat) {
    return store.tasks.filter(t => t.category === cat && !t.done && !t.today);
  },
  addTask(title, category, recurring, recurDays, dueDate, drawer) {
    const task = {
      id: store.nextId++,
      title, category: category || "",
      today: false, todayOrder: null,
      done: false,
      recurring: recurring || null,
      recurDays: (recurDays && recurDays.length) ? recurDays : null,
      dueDate: dueDate || null,
      projectId: null,
      notes: "",
      drawer: !!drawer,
      drawerCategory: null,
      isProject: false,
      trackTime: false,
      timeSessions: []
    };
    store.tasks.push(task);
    return task;
  },
  deleteTask(id) {
    const idx = store.tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    const task = store.tasks[idx];
    store.killedTasks.push({ ...task, killedAt: new Date().toISOString() });
    store.tasks.splice(idx, 1);
    this._reorderToday();
  },
  voteUp(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task || task.today) return;
    const maxOrder = Math.max(0, ...store.tasks.filter(t => t.today && !t.done).map(t => t.todayOrder || 0));
    task.today = true;
    task.todayOrder = maxOrder + 1;
    // Clear drawer flag — task is now in Today
    if (task.drawer) {
      task.drawer = false;
    }
    return task;
  },
  // ─── Drawer methods ───
  getDrawerTasks() {
    return store.tasks.filter(t => t.drawer && !t.done && !t.today);
  },
  moveToDrawer(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    task.drawer = true;
    task.today = false;
    task.todayOrder = null;
    // Keep the date — user can clear it manually if they want "someday"
    this._reorderToday();
    return task;
  },
  moveFromDrawer(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    task.drawer = false;
    return task;
  },
  restoreTask(killedIndex) {
    const killed = store.killedTasks[killedIndex];
    if (!killed) return null;
    store.killedTasks.splice(killedIndex, 1);
    const restored = { ...killed, done: false, today: false, todayOrder: null, killed: false };
    delete restored.killedAt;
    store.tasks.push(restored);
    return restored;
  },
  surfaceDrawerTasks() {
    // No-op — auto-surfacing removed. User controls all section placement.
    return [];
  },
  setTaskDrawerCategory(id, catKey) {
    const task = store.tasks.find(t => t.id === id);
    if (task) task.drawerCategory = task.drawerCategory === catKey ? null : catKey;
  },
  addDrawerCategory(key, label, color) {
    store.drawerCategories[key] = { label, color };
  },
  deleteDrawerCategory(key) {
    delete store.drawerCategories[key];
    store.tasks.forEach(t => { if (t.drawerCategory === key) t.drawerCategory = null; });
    if (store.drawerCatFilter === key) store.drawerCatFilter = null;
  },
  renameDrawerCategory(key, newLabel) {
    if (store.drawerCategories[key]) {
      store.drawerCategories[key].label = newLabel;
    }
  },

  // ─── Project & Time methods ───
  toggleProject(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    task.isProject = !task.isProject;
    if (!task.timeSessions) task.timeSessions = [];
    return task;
  },
  addTimeSession(id, date, minutes, note) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    if (!task.timeSessions) task.timeSessions = [];
    task.timeSessions.push({ date, minutes, note: note || '' });
    return task;
  },
  deleteTimeSession(id, idx) {
    const task = store.tasks.find(t => t.id === id);
    if (!task || !task.timeSessions) return;
    // idx is from the sorted (desc by date) view — find the actual session object
    const sorted = task.timeSessions.slice().sort((a, b) => b.date.localeCompare(a.date));
    const session = sorted[idx];
    if (!session) return;
    const realIdx = task.timeSessions.indexOf(session);
    if (realIdx !== -1) task.timeSessions.splice(realIdx, 1);
  },
  getChecklistProgress(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task || !task.notes) return { checked: 0, total: 0 };
    const lines = task.notes.split('\n');
    let checked = 0, total = 0;
    lines.forEach(l => {
      if (l.startsWith('[x] ')) { checked++; total++; }
      else if (l.startsWith('[ ] ')) { total++; }
    });
    return { checked, total };
  },

  removeFromToday(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    task.today = false;
    task.todayOrder = null;
    this._reorderToday();
    return task;
  },
  toggleDone(id) {
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;
    task.done = !task.done;
    if (task.done) {
      task.completedAt = new Date().toISOString();
      task.today = false;
      task.todayOrder = null;
      this._reorderToday();
      // Respawn recurring tasks
      if (task.recurring) {
        this._respawnRecurring(task);
      }
    } else {
      // Uncompleting — back to On Deck
      task.completedAt = null;
      task.today = false;
      task.todayOrder = null;
    }
    return task;
  },
  _respawnRecurring(original) {
    const nextDate = this._getNextRecurDate(original);

    // Carry over notes but reset checklist items to unchecked
    let respawnedNotes = '';
    if (original.notes) {
      respawnedNotes = original.notes.split('\n').map(line => {
        if (line.startsWith('[x] ')) return '[ ] ' + line.slice(4);
        return line;
      }).join('\n');
    }

    // Recurring projects respawn as projects (stay in Projects section)
    const newTask = {
      id: store.nextId++,
      title: original.title,
      category: original.category,
      today: false,
      todayOrder: null,
      done: false,
      recurring: original.recurring,
      recurDays: original.recurDays ? [...original.recurDays] : null,
      dueDate: nextDate,
      projectId: original.projectId,
      notes: respawnedNotes,
      drawer: false,
      drawerCategory: original.drawerCategory || null,
      isProject: original.isProject || false,
      trackTime: original.trackTime || false,
      timeSessions: [],  // fresh — don't carry over logged time
      projectOrder: original.projectOrder || null
    };
    store.tasks.push(newTask);
    return newTask;
  },
  _getNextRecurDate(task) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    // Start from whichever is later: today or the task's current due date
    // This ensures we always advance PAST the current occurrence
    let base = new Date(now);
    if (task.dueDate) {
      const taskDue = new Date(task.dueDate + 'T00:00:00');
      if (taskDue >= now) base = new Date(taskDue);
    }

    if (task.recurring === 'daily') {
      const d = new Date(base);
      d.setDate(d.getDate() + 1);
      return _localDateStr(d);
    }

    if (task.recurDays && task.recurDays.length && (task.recurring === 'weekly' || task.recurring === 'biweekly')) {
      // Find next matching day of week AFTER base
      const bump = task.recurring === 'biweekly' ? 7 : 0;
      for (let offset = 1; offset <= 21; offset++) {
        const d = new Date(base);
        d.setDate(d.getDate() + offset + bump);
        if (task.recurDays.includes(d.getDay())) {
          return _localDateStr(d);
        }
      }
    }

    if (task.recurring === 'weekly') {
      const d = new Date(base);
      d.setDate(d.getDate() + 7);
      return _localDateStr(d);
    }

    if (task.recurring === 'biweekly') {
      const d = new Date(base);
      d.setDate(d.getDate() + 14);
      return _localDateStr(d);
    }

    if (task.recurring === 'monthly') {
      const d = new Date(base);
      d.setMonth(d.getMonth() + 1);
      return _localDateStr(d);
    }

    if (task.recurring === 'annually') {
      const d = new Date(base);
      d.setFullYear(d.getFullYear() + 1);
      return _localDateStr(d);
    }

    return null;
  },
  reorderToday(orderedIds) {
    orderedIds.forEach((id, i) => {
      const task = store.tasks.find(t => t.id === id);
      if (task) task.todayOrder = i + 1;
    });
  },
  _reorderToday() {
    const todayTasks = this.getTodayTasks();
    todayTasks.forEach((t, i) => t.todayOrder = i + 1);
  }
};

// ─── RENDERING ───
const plusSvg = `<svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;

// Small inline SVG icons (outlined, inherit color)
const calIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.5"/><line x1="2" y1="7" x2="14" y2="7"/><line x1="5" y1="1.5" x2="5" y2="4.5"/><line x1="11" y1="1.5" x2="11" y2="4.5"/></svg>`;
const drawerIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="6" y1="10.5" x2="10" y2="10.5"/></svg>`;
const trackIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 11.5c1-2 2.5-3 4.5-3h2c1 0 2-.3 2.8-1l2.2-2"/><path d="M1.5 11.5c0 1.2.8 2.5 3 2.5h7c1.5 0 3-.5 3-2 0-1-1-1.8-2.5-2l-2-.3"/><circle cx="4" cy="12" r="0.5" fill="currentColor"/><circle cx="7" cy="12.5" r="0.5" fill="currentColor"/></svg>`;
const checkboxIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>`;
const projectIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,4 8,8 11,9.5"/></svg>`;
const sunIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.4" y1="3.4" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="12.6" y2="12.6"/><line x1="3.4" y1="12.6" x2="4.5" y2="11.5"/><line x1="11.5" y1="4.5" x2="12.6" y2="3.4"/></svg>`;
const onDeckIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="2" x2="8" y2="11"/><polyline points="4,8 8,12 12,8"/></svg>`;
const categoryIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2H7l1.5 2H12.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>`;
const copyIconSvg = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-7A1.5 1.5 0 013.5 1h7A1.5 1.5 0 0112 2.5V5"/></svg>`;


const celebrationMessages = [
  "Well Done!", "Crushed It!", "Nice Work!", "Nailed It!", "Done Deal!", "Boom!", "Check!", "You Rock!"
];

function randomCelebration() {
  return celebrationMessages[Math.floor(Math.random() * celebrationMessages.length)];
}

// ─── DATE HELPERS ───
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(d) {
  // mm/dd unless different year, then mm/dd/yy
  const now = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (d.getFullYear() !== now.getFullYear()) {
    return `${m}/${day}/${String(d.getFullYear()).slice(-2)}`;
  }
  return `${m}/${day}`;
}

function formatDueDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((due - today) / (1000 * 60 * 60 * 24));

  const dateText = fmtDate(d);

  if (diff < 0) return { text: dateText, cls: 'overdue' };
  if (diff === 0) return { text: dateText, cls: '' };  // today = normal, not red
  return { text: dateText, cls: '' };
}

function formatRecurring(task) {
  if (!task.recurring) return '';
  const freqMap = { daily: 'D', weekly: 'W', biweekly: 'B', monthly: 'M', annually: 'A' };
  return freqMap[task.recurring] || task.recurring;
}

function render() {
  renderToday();
  renderAddTaskOptions();
  renderProjectsList();
  renderBacklog();
  renderCompleted();
  renderKilled();
  renderDrawer();
  updateCounts();
  applyAllSectionCollapses();
  if (window.innerWidth <= 640) initSwipeToDelete();
}

// ─── SWIPE GESTURES (mobile) ───
// Left-swipe: delete (all sections). Right-swipe: demote to On Deck (Today only).
function initSwipeToDelete() {
  const rows = document.querySelectorAll('.today-item:not(.swipe-ready), .backlog-item:not(.swipe-ready)');
  rows.forEach(row => {
    // Skip rows inside hidden containers or archive popups
    if (row.closest('#completedSection') || row.closest('#killedSection') || row.closest('.archive-popup')) return;

    row.classList.add('swipe-ready');
    const taskId = row.getAttribute('data-id');
    if (!taskId) return;

    // Determine context
    const isDrawerTask = !!row.closest('#drawerContent');
    const isTodayTask = !!row.closest('#todayList');

    // Wrap in swipe container
    const wrap = document.createElement('div');
    wrap.className = 'swipe-row-wrap';
    wrap.innerHTML = '<div class="swipe-delete-bg">Delete</div>'
      + (isTodayTask ? '<div class="swipe-demote-bg">On Deck</div>' : '');
    row.parentNode.insertBefore(wrap, row);
    wrap.appendChild(row);

    let startX = 0, currentX = 0, swiping = false, swipeDir = null;
    const THRESHOLD = 70;

    row.addEventListener('touchstart', (e) => {
      const tag = e.target.closest('.checkbox, .vote-btn, .drag-handle, button');
      if (tag) return;
      startX = e.touches[0].clientX;
      currentX = startX;
      swiping = false;
      swipeDir = null;
    }, { passive: true });

    row.addEventListener('touchmove', (e) => {
      if (startX === 0) return;
      currentX = e.touches[0].clientX;
      const dx = currentX - startX;

      if (!swiping && Math.abs(dx) > 10) {
        swiping = true;
        swipeDir = dx < 0 ? 'left' : 'right';
        wrap.classList.add('swiping');
      }

      if (swiping) {
        if (swipeDir === 'left') {
          const clamped = Math.max(dx, -120);
          row.style.transform = `translateX(${clamped}px)`;
        } else if (swipeDir === 'right' && isTodayTask) {
          const clamped = Math.min(dx, 120);
          row.style.transform = `translateX(${clamped}px)`;
        }
      }
    }, { passive: true });

    row.addEventListener('touchend', () => {
      if (!swiping) { startX = 0; return; }
      wrap.classList.remove('swiping');
      const dx = currentX - startX;

      if (swipeDir === 'left' && dx < -THRESHOLD) {
        // Delete
        wrap.classList.add('deleting');
        setTimeout(() => {
          if (isDrawerTask) {
            handleDrawerTrash(taskId);
          } else {
            handleDeleteTask(taskId);
          }
        }, 250);
      } else if (swipeDir === 'right' && isTodayTask && dx > THRESHOLD) {
        // Demote to On Deck
        wrap.classList.add('demoting');
        setTimeout(() => {
          handleRemoveFromToday(taskId);
        }, 250);
      } else {
        // Snap back
        row.style.transform = '';
      }
      startX = 0;
      currentX = 0;
      swiping = false;
      swipeDir = null;
    }, { passive: true });
  });
}

function renderToday() {
  const el = document.getElementById('todayList');
  const active = api.getTodayTasks();

  if (active.length === 0) {
    el.innerHTML = `<div class="today-empty"><canvas id="emptyApeIcon" width="24" height="24" style="display:block;margin:0 auto 8px;"></canvas>Add or vote up tasks and start the day!</div>`;
    setTimeout(() => { const c = document.getElementById('emptyApeIcon'); if (c) drawPixelApe(c, 0); }, 10);
    return;
  }

  el.innerHTML = active.map(t => todayItemHtml(t)).join('');
}

function todayItemHtml(t) {
  const recurLabel = formatRecurring(t);
  const recurInline = recurLabel
    ? `<span class="recur-inline-icon" onclick="event.stopPropagation(); openScheduleWithRepeat(${qid(t.id)}, this)" title="${recurLabel}">↻</span>`
    : '';

  const due = formatDueDate(t.dueDate);
  const dueHtml = due ? `<span class="task-due task-due-clickable ${due.cls}" onclick="openSchedulePopover(${qid(t.id)}, this)" title="Click to change date">${due.text}</span>` : '';

  return `
    <div class="today-item" data-id="${t.id}">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <span class="today-number" onclick="handleRemoveFromToday(${qid(t.id)})" title="Move to On Deck"><span class="today-number-text">${t.todayOrder}</span><span class="today-number-arrow">↓</span></span>
      <div class="checkbox" onclick="handleToggleDone(${qid(t.id)})"></div>
      <div class="task-content">
        <div class="task-title task-title-clickable" onclick="openNotesSidebar(${qid(t.id)})">${t.title}${t.notes ? '<span class="notes-indicator">📄</span>' : ''}${t.isProject ? '<span class="project-indicator">⏱</span>' : (t.timeSessions && t.timeSessions.length) ? '<span class="time-indicator">◷</span>' : ''}${recurInline}</div>
      </div>
      ${dueHtml}
      <button class="remove-btn" onclick="handleDeleteTask(${qid(t.id)})" title="Delete">✕</button>
    </div>`;
}

function formatCompletedDate(isoStr) {
  if (!isoStr) return '';
  return fmtDate(new Date(isoStr));
}

function renderCompleted() {
  const done = api.getDoneTasks();
  const pill = document.getElementById('completedPill');
  const countEl = document.getElementById('completedPillCount');
  if (done.length === 0) {
    if (pill) pill.style.display = 'none';
    return;
  }
  if (pill) pill.style.display = '';
  if (countEl) countEl.textContent = done.length;
}

function renderKilled() {
  const killed = store.killedTasks;
  const pill = document.getElementById('killedPill');
  const countEl = document.getElementById('killedPillCount');
  if (killed.length === 0) {
    if (pill) pill.style.display = 'none';
    return;
  }
  if (pill) pill.style.display = '';
  if (countEl) countEl.textContent = killed.length;
}

function openArchivePopup(type) {
  const overlay = document.getElementById('archivePopupOverlay');
  const popup = document.getElementById('archivePopup');
  const title = document.getElementById('archivePopupTitle');
  const list = document.getElementById('archivePopupList');

  if (type === 'completed') {
    title.textContent = 'Crushed';
    const done = api.getDoneTasks();
    if (done.length === 0) {
      list.innerHTML = '<div class="archive-popup-empty">No crushed tasks yet.</div>';
    } else {
      const sorted = [...done].sort((a, b) => {
        const aDate = a.completedAt || '';
        const bDate = b.completedAt || '';
        return bDate.localeCompare(aDate);
      });

      // Group by time period
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      let currentGroup = '';
      let html = '';
      sorted.forEach(t => {
        const completed = t.completedAt ? new Date(t.completedAt) : null;
        let group;
        if (!completed || completed >= thisMonthStart) {
          group = 'THIS MONTH';
        } else if (completed >= lastMonthStart) {
          group = 'LAST MONTH';
        } else {
          group = 'OLDER';
        }
        if (group !== currentGroup) {
          currentGroup = group;
          html += `<div class="archive-time-group">${group}</div>`;
        }
        const dateStr = formatCompletedDate(t.completedAt);
        const projInfo = t.isProject ? '<span class="project-indicator">⏱</span>' : '';
        const totalMins = (t.timeSessions || []).reduce((sum, s) => sum + s.minutes, 0);
        const timeInfo = totalMins ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px;">${formatMinutes(totalMins)}</span>` : '';
        html += `
          <div class="completed-task">
            <span class="done-check uncheckable" onclick="handleUncomplete(${qid(t.id)}); closeArchivePopup();" title="Undo — restore task">✓</span>
            <span class="done-title">${t.title}${projInfo}${timeInfo}</span>
            ${dateStr ? `<span class="done-date">${dateStr}</span>` : ''}
          </div>`;
      });
      list.innerHTML = html;
    }
  } else {
    title.textContent = 'Killed';
    const killed = store.killedTasks;
    if (killed.length === 0) {
      list.innerHTML = '<div class="archive-popup-empty">No killed tasks.</div>';
    } else {
      // Sort by killedAt descending
      const sorted = [...killed].map((t, origIdx) => ({ ...t, _killedIdx: origIdx }))
        .sort((a, b) => (b.killedAt || '').localeCompare(a.killedAt || ''));

      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

      let currentGroup = '';
      let html = '';
      sorted.forEach(t => {
        const killedDate = t.killedAt ? new Date(t.killedAt) : null;
        let group;
        if (!killedDate || killedDate >= thisMonthStart) {
          group = 'THIS MONTH';
        } else if (killedDate >= lastMonthStart) {
          group = 'LAST MONTH';
        } else {
          group = 'OLDER';
        }
        if (group !== currentGroup) {
          currentGroup = group;
          html += `<div class="archive-time-group">${group}</div>`;
        }
        const dateStr = t.killedAt ? fmtDate(new Date(t.killedAt)) : '';
        html += `
          <div class="completed-task">
            <span class="done-check killed-check uncheckable" onclick="handleRestoreTask(${t._killedIdx}); closeArchivePopup();" title="Restore task">✕</span>
            <span class="done-title killed-title">${t.title}</span>
            ${dateStr ? `<span class="done-date">${dateStr}</span>` : ''}
          </div>`;
      });
      list.innerHTML = html;
    }
  }

  overlay.classList.add('open');
  popup.classList.add('open');
}

function closeArchivePopup() {
  document.getElementById('archivePopupOverlay').classList.remove('open');
  document.getElementById('archivePopup').classList.remove('open');
}

function renderProjectsList() {
  const el = document.getElementById('projectsList');
  const emptyEl = document.getElementById('projectsEmpty');
  const projects = api.getProjectTasks();

  const countEl = document.getElementById('projectsCount');
  if (countEl) countEl.textContent = projects.length ? `(${projects.length})` : '';

  if (!projects.length) {
    el.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  el.innerHTML = projects.map((t, idx) => {
    const prog = api.getChecklistProgress(t.id);
    const pct = prog.total > 0 ? Math.round((prog.checked / prog.total) * 100) : 0;
    const progressHtml = prog.total > 0
      ? `<div class="project-progress-bar">
           <div class="project-progress-fill" style="width:${pct}%"></div>
         </div>`
      : '';

    const totalMins = (t.timeSessions || []).reduce((sum, s) => sum + s.minutes, 0);
    const timeHtml = totalMins
      ? `<span class="project-time-link" onclick="openNotesSidebar(${qid(t.id)})" title="View time log">⏱ ${formatMinutes(totalMins)}</span>`
      : `<span class="project-time-link muted" onclick="openNotesSidebar(${qid(t.id)})" title="Log time">⏱ track</span>`;

    const due = formatDueDate(t.dueDate);
    const dateBtn = due
      ? `<span class="task-due task-due-clickable ${due.cls}" onclick="openSchedulePopover(${qid(t.id)}, this)" title="Change date">${due.text}</span>`
      : '';
    const recurInline = t.recurring
      ? `<span class="recur-inline-icon" onclick="event.stopPropagation(); openScheduleWithRepeat(${qid(t.id)}, this)">↻</span>`
      : '';

    return `
      <div class="today-item project-row" data-id="${t.id}">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <span class="today-number">${idx + 1}</span>
        <div class="checkbox" onclick="handleProjectComplete(${qid(t.id)})"></div>
        <div class="task-content">
          <div class="task-title task-title-clickable" onclick="openNotesSidebar(${qid(t.id)})">
            ${t.title}${t.notes ? '<span class="notes-indicator">📄</span>' : ''}${recurInline}
          </div>
        </div>
        <div class="project-meta-right">
          ${progressHtml}
          ${timeHtml}
          ${dateBtn}
        </div>
        <button class="remove-btn" onclick="handleDeleteTask(${qid(t.id)})" title="Delete">✕</button>
      </div>`;
  }).join('');
}

function copyProjectsList() {
  const projects = api.getProjectTasks();
  if (!projects.length) {
    showToast('No projects to copy');
    return;
  }
  const lines = [];
  projects.forEach((t, idx) => {
    lines.push(`${idx + 1}. ${t.title}`);
    // Checklist items from notes
    if (t.notes) {
      t.notes.split('\n').forEach(line => {
        if (line.startsWith('[x] ')) {
          lines.push(`   ✓ ${line.slice(4)}`);
        } else if (line.startsWith('[ ] ')) {
          lines.push(`   ☐ ${line.slice(4)}`);
        } else if (line.trim()) {
          lines.push(`   ${line}`);
        }
      });
    }
    // Progress + time
    const prog = api.getChecklistProgress(t.id);
    const totalMins = (t.timeSessions || []).reduce((sum, s) => sum + s.minutes, 0);
    const meta = [];
    if (prog.total > 0) meta.push(`${prog.checked}/${prog.total} done`);
    if (totalMins) meta.push(formatMinutes(totalMins) + ' tracked');
    if (t.dueDate) meta.push('due ' + t.dueDate);
    if (meta.length) lines.push(`   [${meta.join(' · ')}]`);
    lines.push('');
  });
  navigator.clipboard.writeText(lines.join('\n').trim()).then(() => {
    showToast('Projects copied to clipboard');
  }).catch(() => {
    showToast('Copy failed');
  });
}

function copyProjectToClipboard(id) {
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;
  const lines = [task.title];
  if (task.notes) {
    task.notes.split('\n').forEach(line => {
      if (line.startsWith('[x] ')) {
        lines.push(`  ✓ ${line.slice(4)}`);
      } else if (line.startsWith('[ ] ')) {
        lines.push(`  ☐ ${line.slice(4)}`);
      } else if (line.trim()) {
        lines.push(`  ${line}`);
      }
    });
  }
  const prog = api.getChecklistProgress(task.id);
  const totalMins = (task.timeSessions || []).reduce((sum, s) => sum + s.minutes, 0);
  const meta = [];
  if (prog.total > 0) meta.push(`${prog.checked}/${prog.total} done`);
  if (totalMins) meta.push(formatMinutes(totalMins) + ' tracked');
  if (task.dueDate) meta.push('due ' + task.dueDate);
  if (meta.length) lines.push(`[${meta.join(' · ')}]`);
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast('Copied to clipboard');
  }).catch(() => {
    showToast('Copy failed');
  });
}

function renderBacklogItem(t) {
  const recurLabel = formatRecurring(t);
  const recurInline = recurLabel
    ? `<span class="recur-inline-icon" onclick="event.stopPropagation(); openScheduleWithRepeat(${qid(t.id)}, this)" title="${recurLabel}">↻</span>`
    : '';

  const due = formatDueDate(t.dueDate);
  const dateBtn = due
    ? `<span class="task-due task-due-clickable ${due.cls}" onclick="openSchedulePopover(${qid(t.id)}, this)" title="Change date">${due.text}</span>`
    : `<span class="task-due task-due-clickable" onclick="openSchedulePopover(${qid(t.id)}, this)" title="Set date" style="opacity:0.4;font-size:11px;">+ date</span>`;

  return `
    <div class="backlog-item" data-id="${t.id}">
      <button class="vote-btn" onclick="handleVoteUp(${qid(t.id)})" title="Add to today">
        ${plusSvg}
      </button>
      <span class="backlog-task-title backlog-task-title-clickable" onclick="openNotesSidebar(${qid(t.id)})">${t.title}${t.notes ? '<span class="notes-indicator">📄</span>' : ''}${t.isProject ? '<span class="project-indicator">⏱</span>' : (t.timeSessions && t.timeSessions.length) ? '<span class="time-indicator">◷</span>' : ''}${recurInline}</span>
      ${dateBtn}
      <div class="backlog-actions">
        <button class="remove-btn" onclick="handleDeleteTask(${qid(t.id)})" title="Delete">✕</button>
      </div>
    </div>`;
}

function renderBacklog() {
  const el = document.getElementById('backlogList');
  const tasks = api.getBacklogTasks();

  const onDeckCountEl = document.getElementById('onDeckCount');
  if (onDeckCountEl) onDeckCountEl.textContent = tasks.length ? `(${tasks.length})` : '';

  const now = new Date(); now.setHours(0,0,0,0);
  let olderCount = 0;

  // Render all items, marking 30+ day items with data-older
  let html = '';
  tasks.forEach(t => {
    let isOlder = false;
    if (t.dueDate) {
      const due = new Date(t.dueDate + 'T00:00:00');
      const days = Math.round((due - now) / (1000*60*60*24));
      if (days > 30) { isOlder = true; olderCount++; }
    }
    const item = renderBacklogItem(t);
    if (isOlder) {
      // Inject data-older attribute into the backlog-item div
      html += item.replace('<div class="backlog-item"', '<div class="backlog-item" data-older="true"');
    } else {
      html += item;
    }
  });

  // Add toggle link if there are 30+ day items
  if (olderCount > 0) {
    const label = _olderHidden ? `Show 30+ days (${olderCount})` : `Hide 30+ days`;
    html += `<div class="older-toggle" onclick="toggleOlderItems()">${label}</div>`;
  }

  el.innerHTML = html;
  applyOlderVisibility();
}

function renderProjects() {
  const el = document.getElementById('projectList');
  el.innerHTML = store.projects.map(p => {
    const completedCount = p.steps.filter(s => s.status === 'completed').length;
    const pct = Math.round((completedCount / p.steps.length) * 100);

    return `
      <div class="project-card" data-project="${p.id}">
        <div class="project-header" onclick="toggleProject(${p.id})">
          <span class="project-name">${p.name}</span>
          <span class="project-progress">
            <span>${completedCount}/${p.steps.length}</span>
            <span class="progress-bar"><span class="progress-fill" style="width:${pct}%"></span></span>
          </span>
        </div>
        <div class="project-steps">
          ${p.steps.map(s => `
            <div class="project-step">
              <span class="step-indicator ${s.status}">${s.status === 'completed' ? '✓' : ''}</span>
              <span class="step-name ${s.status === 'completed' ? 'completed-step' : ''} ${s.status === 'current' ? 'current-step' : ''}">${s.name}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderCategories() {
  const el = document.getElementById('categoryAccordion');
  el.innerHTML = Object.entries(categories).map(([key, cat]) => {
    const tasks = api.getTasksByCategory(key);
    return `
      <div class="category-group" data-cat="${key}">
        <div class="category-header" onclick="toggleCategory('${key}')">
          <span class="category-name">
            <span class="category-dot" style="background:${cat.color}"></span>
            ${cat.label}
          </span>
          <span style="display:flex;align-items:center;gap:6px;">
            <button class="cat-delete-btn" onclick="event.stopPropagation(); handleDeleteCategory('${key}')" title="Delete category">✕</button>
            <span class="category-toggle">
              ${tasks.length} task${tasks.length !== 1 ? 's' : ''}
              <span class="arrow">▾</span>
            </span>
          </span>
        </div>
        <div class="category-items">
          ${tasks.map(t => {
            const rl = formatRecurring(t);
            const dd = formatDueDate(t.dueDate);
            return `
            <div class="category-task">
              <button class="mini-vote" onclick="handleVoteUp(${qid(t.id)})" title="Add to today">${plusSvg}</button>
              <span>${t.title}</span>
              ${rl ? `<span class="tag tag-recurring">↻ ${rl}</span>` : ''}
              ${dd ? `<span class="task-due ${dd.cls}">${dd.text}</span>` : ''}
            </div>`;
          }).join('')}
          ${tasks.length === 0 ? '<div class="category-task" style="color:var(--text-muted)">No tasks</div>' : ''}
        </div>
      </div>`;
  }).join('');

  // Add "new category" row at the bottom
  el.innerHTML += `
    <div class="cat-crud-row">
      <input type="color" class="cat-color-picker" id="newCatColor" value="#6366f1" title="Pick color">
      <input type="text" class="cat-crud-input" id="newCatName" placeholder="New category name…" onkeydown="if(event.key==='Enter')handleAddCategory()">
      <button class="cat-add-btn" onclick="handleAddCategory()">+ Add</button>
    </div>`;
}

function getDefaultDueDate() {
  // Default: 1 week from today
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return _localDateStr(d);
}

function getDefaultProjectDueDate() {
  // Default: 30 days from today for projects
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return _localDateStr(d);
}

// Legacy alias — schedule popover and other code still calls this
function renderAddTaskOptions() {
  // Only render if modal is open
  if (document.getElementById('addModal').classList.contains('open')) {
    renderAddModalPills();
  }
}

function _localDateStr(d) {
  // Local YYYY-MM-DD (not UTC) for timezone-correct day boundaries
  const dd = d || new Date();
  return dd.getFullYear() + '-' + String(dd.getMonth()+1).padStart(2,'0') + '-' + String(dd.getDate()).padStart(2,'0');
}

function _tsToLocalDate(ts) {
  // Convert an ISO timestamp to local YYYY-MM-DD
  return _localDateStr(new Date(ts));
}

function updateCounts() {
  // Counter = today's completion events from log (local timezone)
  const todayStr = _localDateStr();
  const logToday = completionLog.filter(e => e.ts && _tsToLocalDate(e.ts) === todayStr).length;
  const counter = document.getElementById('dailyCounter');
  if (counter) counter.textContent = logToday;
}

function bumpCounter() {
  if (typeof logCompletion === 'function') logCompletion();
  // Update the counter number (logCompletion just pushed to completionLog)
  updateCounts();
  const counter = document.getElementById('dailyCounter');
  if (!counter) return;
  counter.classList.remove('bump');
  // Force reflow to restart animation
  void counter.offsetWidth;
  counter.classList.add('bump');
}

// ─── MINI REWARD (sub-task) ───
// Confetti burst near counter + ape jump — visual only, no counter/HOF increment
function miniReward() {
  // Ape jump celebration
  try {
    if (typeof apeJump === 'function') apeJump();
  } catch(e) {}
  // Confetti burst near the daily counter
  try { spawnConfetti(); } catch(e) {}
}

function spawnConfetti() {
  const counter = document.getElementById('dailyCounter');
  if (!counter) return;
  const rect = counter.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const colors = ['#e52e0a', '#f04a28', '#2456a4', '#5b8fd9', '#2a7d4f', '#d4a843', '#f5f0e6'];
  for (let i = 0; i < 12; i++) {
    const dot = document.createElement('div');
    dot.className = 'confetti-dot';
    dot.style.left = cx + 'px';
    dot.style.top = cy + 'px';
    dot.style.backgroundColor = colors[i % colors.length];
    // Random direction
    const angle = (Math.PI * 2 * i) / 12 + (Math.random() - 0.5) * 0.5;
    const dist = 30 + Math.random() * 40;
    dot.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
    dot.style.setProperty('--ty', Math.sin(angle) * dist - 20 + 'px');
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }
}

// ─── EVENT HANDLERS ───
function sortTodayByDate() {
  const btn = document.getElementById('sortDateBtn');
  const today = store.tasks.filter(t => t.today && !t.done);

  // Sort by due date — tasks with dates first (soonest first), undated at bottom
  today.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  // Reassign todayOrder
  today.forEach((t, i) => t.todayOrder = i + 1);

  // Flash the button active briefly
  btn.classList.add('active');
  setTimeout(() => btn.classList.remove('active'), 600);

  render();
  showToast('Sorted by due date');
}

function handleVoteUp(id) {
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;
  api.voteUp(currentId);
  render();
  showToast('Added to today');
}

function handleRemoveFromToday(id) {
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;
  api.removeFromToday(currentId);
  render();
  showToast('Moved to On Deck');
}

function handleProjectComplete(id) {
  const row = document.querySelector(`.today-item[data-id="${id}"]`);
  if (!row) return;

  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;

  const checkbox = row.querySelector('.checkbox');
  checkbox.classList.add('completing');
  row.classList.add('completing-row');

  setTimeout(() => {
    row.classList.add('fade-out');
    setTimeout(() => {
      api.toggleDone(currentId);
      try { render(); } catch(e) { console.error('render error:', e); }
      try { bumpCounter(); } catch(e) { console.error('bumpCounter error:', e); }
      try { spawnCreature(); } catch(e) { console.error('spawnCreature error:', e); }
      showToast('Project complete! 🎉');
    }, 350);
  }, 1000);
}

function handleToggleDone(id) {
  const row = document.querySelector(`.today-item[data-id="${id}"]`);
  if (!row) return;

  // Red checkbox with white check — pops in
  const checkbox = row.querySelector('.checkbox');
  checkbox.classList.add('completing');
  row.classList.add('completing-row');

  // Resolve task now — ID may have changed from integer to UUID
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const wasRecurring = task && task.recurring;
  const taskTitle = task ? task.title : '';
  // Capture the CURRENT task ID (may be UUID now, even though onclick had integer)
  const currentId = task ? task.id : id;

  // Hold for 1 second so user sees the satisfying check
  setTimeout(() => {
    row.classList.add('fade-out');
    setTimeout(() => {
      // Use the resolved current ID for the toggle
      api.toggleDone(currentId);
      try { render(); } catch(e) { console.error('render error:', e); }
      try { bumpCounter(); } catch(e) { console.error('bumpCounter error:', e); }
      try { spawnCreature(); } catch(e) { console.error('spawnCreature error:', e); }
      // Notify about recurring respawn
      if (wasRecurring) {
        const respawned = store.tasks.find(t => t.title === taskTitle && !t.done && t.id !== currentId);
        if (respawned) {
          showToast(`↻ "${respawned.title}" respawned to On Deck`);
        }
      }
    }, 350);
  }, 1000);
}

function handleUncomplete(id) {
  api.toggleDone(id);
  // Remove the most recent completion event from local log
  if (completionLog.length > 0) {
    completionLog.pop();
  }
  // Remove from DB — tracked through sync guard so fallback poll
  // won't pull the not-yet-deleted event back and bounce the counter.
  // Also suppress the realtime echo for this delete.
  if (window.TinyApeDB && window.TinyApeDB.deleteLatestCompletionEvent) {
    // Mark as our own write so realtime ignores the DELETE event
    if (window._markCompletionWrite) window._markCompletionWrite();
    if (window._trackAsyncOp) {
      window._trackAsyncOp(() =>
        window.TinyApeDB.deleteLatestCompletionEvent()
      ).catch(err => console.error('Error removing completion event:', err));
    } else {
      window.TinyApeDB.deleteLatestCompletionEvent().catch(err =>
        console.error('Error removing completion event:', err));
    }
  }
  render();
  renderHallOfFame();
  showToast('Task restored to On Deck');
}

function toggleProject(id) {
  const card = document.querySelector(`.project-card[data-project="${id}"]`);
  card.classList.toggle('open');
}

function toggleCategory(cat) {
  const group = document.querySelector(`.category-group[data-cat="${cat}"]`);
  group.classList.toggle('open');
}

// toggleCompleted / toggleKilled removed — now using archive popup

// Add task
// ─── ADD TASK MODAL ───
let addModalContext = 'ondeck';  // 'today', 'ondeck', 'project', 'drawer'
let addModalDestination = 'ondeck'; // selected destination for OK button
let addTaskListMode = false;

// ─── Modal notes helpers (contenteditable div) ───
function getModalNotesText() {
  const el = document.getElementById('addTaskNotes');
  return notesHtmlToText(el);
}
function setModalNotesText(text) {
  const el = document.getElementById('addTaskNotes');
  el.innerHTML = notesTextToHtml(text);
}
function clearModalNotes() {
  const el = document.getElementById('addTaskNotes');
  el.innerHTML = '';
}
function setModalNotesPlaceholder(text) {
  document.getElementById('addTaskNotes').setAttribute('data-placeholder', text);
}
function placeCursorAfterCheckbox(container) {
  // Find the last .notes-line-text span and place cursor at end
  const spans = container.querySelectorAll('.notes-line-text');
  const target = spans.length ? spans[spans.length - 1] : null;
  if (target) {
    container.focus();
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(target);
    range.collapse(false); // collapse to end
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    container.focus();
  }
}

// Track selected category for drawer add modal
let addModalDrawerCategory = null;

function openAddModal(context) {
  addModalContext = context || 'ondeck';
  addModalDestination = (context === 'today') ? 'today'
    : (context === 'project') ? 'ondeck'
    : (context === 'drawer') ? 'drawer'
    : 'ondeck';
  store.addTaskAsProject = (context === 'project');
  addTaskListMode = (context === 'project');  // auto-list mode for projects
  store.selectedDueDate = null;
  store.selectedRecurring = null;
  store.selectedRecurDays = [];
  addModalDrawerCategory = null;

  const modal = document.getElementById('addModal');
  const overlay = document.getElementById('addModalOverlay');
  const input = document.getElementById('addTaskInput');
  const titleEl = document.getElementById('addModalTitle');
  const notesWrap = document.getElementById('addModalNotesWrap');
  const notes = document.getElementById('addTaskNotes');

  // Context-aware title and placeholder
  const subtitleEl = document.getElementById('addModalSubtitle');
  if (context === 'project') {
    titleEl.textContent = 'Add a project';
    subtitleEl.textContent = 'For multi-step tasks with progress and time tracking';
    subtitleEl.style.display = '';
    input.placeholder = 'Project name…';
    setModalNotesPlaceholder('Break it into steps…');
    notesWrap.classList.add('open');  // auto-expand notes for projects
    setModalNotesText('[ ] ');
  } else if (context === 'today') {
    titleEl.textContent = 'Add to Today';
    subtitleEl.style.display = 'none';
    input.placeholder = 'What needs to be done?';
    setModalNotesPlaceholder('Add notes…');
    notesWrap.classList.add('open');
    clearModalNotes();
  } else if (context === 'drawer') {
    titleEl.textContent = 'Add to Drawer';
    subtitleEl.style.display = 'none';
    input.placeholder = 'What needs to be done?';
    setModalNotesPlaceholder('Add notes…');
    notesWrap.classList.add('open');
    clearModalNotes();
  } else {
    titleEl.textContent = 'Add a task';
    subtitleEl.style.display = 'none';
    input.placeholder = 'What needs to be done?';
    setModalNotesPlaceholder('Add notes…');
    notesWrap.classList.add('open');
    clearModalNotes();
  }

  renderAddModalPills();
  renderAddModalActions();
  modal.classList.add('open');
  overlay.classList.add('open');

  // On mobile, lock body scroll
  if (window.innerWidth <= 640) {
    window._modalScrollY = window.scrollY;
    document.body.classList.add('modal-open');
    document.body.style.top = `-${window._modalScrollY}px`;
  }

  setTimeout(() => input.focus(), 100);
}

function closeAddModal() {
  // If there's a title, auto-save to the contextual default destination
  // so the user doesn't lose their work when closing via X or overlay.
  const input = document.getElementById('addTaskInput');
  const title = input.value.trim();
  if (title) {
    addModalSubmit(addModalDestination);
    return; // addModalSubmit calls _resetAddModal internally
  }

  _resetAddModal();
}

// Internal reset — separates modal cleanup from the close-with-save logic
function _resetAddModal() {
  document.getElementById('addModal').classList.remove('open');
  document.getElementById('addModalOverlay').classList.remove('open');

  // Restore body scroll on mobile
  if (document.body.classList.contains('modal-open')) {
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, window._modalScrollY || 0);
  }
  const input = document.getElementById('addTaskInput');
  input.value = '';
  clearModalNotes();
  document.getElementById('addModalNotesWrap').classList.remove('open');
  store.addTaskAsProject = false;
  store.addTaskTrackTime = false;
  // Clean up category accordion
  addModalCatAccordionOpen = false;
  addModalNewCatColor = null;
  addModalDrawerCategory = null;
  const catAcc = document.getElementById('addModalCatAccordion');
  if (catAcc) catAcc.remove();
  const trackSection = document.getElementById('addModalTrackSection');
  if (trackSection) {
    trackSection.style.display = 'none';
    const slider = document.getElementById('addTrackSlider');
    const sliderLabel = document.getElementById('addTrackSliderLabel');
    const note = document.getElementById('addTrackNote');
    if (slider) slider.value = 30;
    if (sliderLabel) sliderLabel.textContent = '30m';
    if (note) note.value = '';
  }
  store.selectedDueDate = null;
  store.selectedRecurring = null;
  store.selectedRecurDays = [];
  addTaskListMode = false;
}

function renderAddModalPills() {
  const el = document.getElementById('addModalPills');

  // Date pill — default to today when adding from Today context
  const isTodayCtx = addModalContext === 'today';
  const defaultDate = isTodayCtx ? _localDateStr() : getDefaultDueDate();
  const effectiveDate = store.selectedDueDate || defaultDate;
  const dl = formatDueDate(effectiveDate);
  const dateLabel = dl ? dl.text : effectiveDate;
  const recurPart = store.selectedRecurring ? ' · ↻' : '';
  const isCustomDate = store.selectedDueDate || store.selectedRecurring || store.selectedRecurDays.length;

  let html = '';
  html += `<button class="add-modal-pill ${isCustomDate ? 'active' : ''}" id="addTaskSchedBtn" onclick="openAddTaskSchedule(this)">${calIconSvg} ${dateLabel}${recurPart}</button>`;
  html += `<button class="add-modal-pill ${store.addTaskTrackTime ? 'active' : ''}" onclick="toggleAddTrackTime()">${trackIconSvg} Track</button>`;
  html += `<button class="add-modal-pill ${store.addTaskAsProject ? 'active' : ''}" onclick="toggleAddAsProject()">${projectIconSvg} Project</button>`;
  html += `<button class="add-modal-pill ${addTaskListMode ? 'active' : ''}" onclick="toggleModalListMode()">${checkboxIconSvg} List</button>`;

  // Category picker — shown when adding to drawer
  if (addModalContext === 'drawer') {
    const cats = store.drawerCategories;
    const catEntries = Object.entries(cats);
    if (catEntries.length) {
      const catLabel = addModalDrawerCategory && cats[addModalDrawerCategory]
        ? cats[addModalDrawerCategory].label
        : 'Category';
      const catColor = addModalDrawerCategory && cats[addModalDrawerCategory]
        ? cats[addModalDrawerCategory].color
        : 'var(--text-muted)';
      const dotHtml = `<span style="width:6px;height:6px;border-radius:50%;background:${catColor};display:inline-block;margin-right:2px;"></span>`;
      html += `<button class="add-modal-pill ${addModalDrawerCategory ? 'active' : ''}" onclick="cycleAddModalCategory()">${dotHtml} ${catLabel}</button>`;
    }
  }

  // Helper text removed — each section now has its own sensible default date

  el.innerHTML = html;
}

let addModalCatAccordionOpen = false;
let addModalNewCatColor = null;

function cycleAddModalCategory() {
  addModalCatAccordionOpen = !addModalCatAccordionOpen;
  renderAddModalCatAccordion();
}

function renderAddModalCatAccordion() {
  let acc = document.getElementById('addModalCatAccordion');
  if (!addModalCatAccordionOpen) {
    if (acc) acc.remove();
    return;
  }

  const cats = store.drawerCategories;
  const catEntries = Object.entries(cats);

  if (!acc) {
    acc = document.createElement('div');
    acc.id = 'addModalCatAccordion';
    acc.className = 'add-modal-cat-accordion';
    const pillsEl = document.getElementById('addModalPills');
    pillsEl.insertAdjacentElement('afterend', acc);
  }

  // Existing categories — click to select, ✕ to delete
  let html = '<div class="add-modal-cat-list">';
  catEntries.forEach(([key, cat]) => {
    const isActive = addModalDrawerCategory === key;
    html += `<span class="add-modal-cat-chip ${isActive ? 'active' : ''}" onclick="selectAddModalCategory('${key}')">
      <span class="cat-dot" style="background:${cat.color}"></span>${cat.label}<span class="add-modal-cat-x" onclick="event.stopPropagation(); deleteAddModalCategory('${key}')" title="Remove">✕</span>
    </span>`;
  });
  // "Someday" option (no category)
  const noActive = !addModalDrawerCategory;
  html += `<span class="add-modal-cat-chip ${noActive ? 'active' : ''}" onclick="selectAddModalCategory(null)">
    <span class="cat-dot" style="background:var(--text-muted)"></span>Someday
  </span>`;
  html += '</div>';

  // Add new category form
  html += `<div class="add-modal-cat-new">
    <input type="text" id="addModalNewCatName" placeholder="New category…" />
    <div class="add-modal-cat-colors">
      ${catColorOptions.map(c =>
        `<span class="drawer-cat-color-opt ${c === addModalNewCatColor ? 'selected' : ''}" style="background:${c};" onclick="event.stopPropagation(); pickAddModalCatColor('${c}')"></span>`
      ).join('')}
    </div>
    <button class="add-modal-cat-save" onclick="saveAddModalNewCategory()">Add category</button>
  </div>`;

  acc.innerHTML = html;

  // Default color for new category
  if (!addModalNewCatColor) {
    addModalNewCatColor = catColorOptions[catEntries.length % catColorOptions.length];
    // Update the selected dot
    const dot = acc.querySelector(`.drawer-cat-color-opt[style*="${addModalNewCatColor}"]`);
    if (dot) dot.classList.add('selected');
  }

  // Enter key on name input
  const nameInput = document.getElementById('addModalNewCatName');
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveAddModalNewCategory();
    });
  }
}

function selectAddModalCategory(key) {
  addModalDrawerCategory = key;
  renderAddModalPills();
  renderAddModalCatAccordion();
}

function deleteAddModalCategory(key) {
  api.deleteDrawerCategory(key);
  if (addModalDrawerCategory === key) addModalDrawerCategory = null;
  renderAddModalPills();
  renderAddModalCatAccordion();
  renderDrawer(); // update desktop drawer too
}

function pickAddModalCatColor(color) {
  addModalNewCatColor = color;
  document.querySelectorAll('#addModalCatAccordion .drawer-cat-color-opt').forEach(el => el.classList.remove('selected'));
  const match = document.querySelector(`#addModalCatAccordion .drawer-cat-color-opt[style*="${color}"]`);
  if (match) match.classList.add('selected');
}

function saveAddModalNewCategory() {
  const input = document.getElementById('addModalNewCatName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const key = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const color = addModalNewCatColor || catColorOptions[0];
  api.addDrawerCategory(key, name, color);
  addModalDrawerCategory = key; // auto-select the new category
  addModalNewCatColor = null;
  renderAddModalPills();
  renderAddModalCatAccordion();
  renderDrawer();
}

function renderAddModalActions() {
  const el = document.getElementById('addModalActions');
  el.innerHTML = `<button class="add-modal-action-btn primary" onclick="addModalSubmit(addModalDestination)">OK</button>`;
}

function toggleAddAsProject() {
  store.addTaskAsProject = !store.addTaskAsProject;
  const input = document.getElementById('addTaskInput');
  const titleEl = document.getElementById('addModalTitle');
  const notesWrap = document.getElementById('addModalNotesWrap');
  const notes = document.getElementById('addTaskNotes');

  const subtitleEl = document.getElementById('addModalSubtitle');
  if (store.addTaskAsProject) {
    titleEl.textContent = 'Add a project';
    subtitleEl.textContent = 'For multi-step tasks with progress and time tracking';
    subtitleEl.style.display = '';
    input.placeholder = 'Project name…';
    notesWrap.classList.add('open');
    if (!getModalNotesText().trim()) {
      setModalNotesText('[ ] ');
      addTaskListMode = true;
      setTimeout(() => placeCursorAfterCheckbox(notes), 50);
    }
    setModalNotesPlaceholder('Break it into steps…');
  } else {
    titleEl.textContent = addModalContext === 'today' ? 'Add to Today' : 'Add a task';
    subtitleEl.style.display = 'none';
    input.placeholder = 'What needs to be done?';
    setModalNotesPlaceholder('Add notes…');
  }
  renderAddModalPills();
  renderAddModalActions();
}

function toggleAddTrackTime() {
  store.addTaskTrackTime = !store.addTaskTrackTime;
  const section = document.getElementById('addModalTrackSection');
  if (section) section.style.display = store.addTaskTrackTime ? '' : 'none';
  renderAddModalPills();
}

function toggleModalListMode() {
  addTaskListMode = !addTaskListMode;
  const el = document.getElementById('addTaskNotes');
  const notesWrap = document.getElementById('addModalNotesWrap');

  if (addTaskListMode) {
    notesWrap.classList.add('open');
    const currentText = getModalNotesText();
    const lines = currentText.split('\n');
    const newText = lines.map(l => {
      const trimmed = l.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('[ ] ') || trimmed.startsWith('[x] ')) return l;
      return '[ ] ' + trimmed;
    }).join('\n');
    setModalNotesText(newText.trim() || '[ ] ');
    placeCursorAfterCheckbox(el);
  } else {
    const currentText = getModalNotesText();
    const lines = currentText.split('\n');
    const newText = lines.map(l => l.replace(/^\[[ x]\] /, '')).join('\n');
    setModalNotesText(newText);
    el.focus();
  }
  renderAddModalPills();
}

function addModalSubmit(destination) {
  const input = document.getElementById('addTaskInput');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }

  const notes = getModalNotesText().trim();
  const isDrawer = (destination === 'drawer');
  const isToday = (destination === 'today');
  const todayStr = _localDateStr();
  // When adding to Today, force due date to today (override 1-week default)
  if (isToday && !store.selectedDueDate) {
    store.selectedDueDate = todayStr;
    renderAddModalPills(); // visually snap the calendar pill to today
  }
  // Default dates by section: Today → today, Drawer → none, Projects → +30 days, On Deck → +7 days
  let dueDate;
  if (isToday) {
    dueDate = store.selectedDueDate || todayStr;
  } else if (isDrawer) {
    dueDate = store.selectedDueDate || null;
  } else if (store.addTaskAsProject) {
    dueDate = store.selectedDueDate || getDefaultProjectDueDate();
  } else {
    dueDate = store.selectedDueDate || getDefaultDueDate();
  }

  const task = api.addTask(
    title, '',
    store.selectedRecurring,
    [...store.selectedRecurDays],
    dueDate,
    isDrawer
  );

  task.notes = notes;

  // Assign drawer category if set
  if (isDrawer && addModalDrawerCategory) {
    task.drawerCategory = addModalDrawerCategory;
  }

  // Mark as project if toggled
  if (store.addTaskAsProject) {
    task.isProject = true;
    if (!task.timeSessions) task.timeSessions = [];
  }

  // Enable time tracking if toggled
  if (store.addTaskTrackTime) {
    task.trackTime = true;
    if (!task.timeSessions) task.timeSessions = [];
    // Save initial time session if slider was adjusted
    const slider = document.getElementById('addTrackSlider');
    const note = document.getElementById('addTrackNote');
    if (slider && parseInt(slider.value) > 0) {
      const minutes = parseInt(slider.value);
      const noteText = note ? note.value.trim() : '';
      const todayStr2 = _localDateStr();
      task.timeSessions.push({ date: todayStr2, minutes, note: noteText });
    }
  }

  // Vote up to Today if that's the destination
  if (destination === 'today') {
    if (!task.dueDate) task.dueDate = _localDateStr();
    api.voteUp(task.id);
  }

  _resetAddModal();
  render();

  const label = task.isProject ? 'Project' : 'Task';
  if (destination === 'today') showToast(`${label} added to Today`);
  else if (isDrawer) { showToast(`${label} added to Drawer`); }
  else showToast(`${label} added to On Deck`);
}

// Keyboard shortcuts for the modal
document.getElementById('addTaskInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    addModalSubmit(addModalDestination);
  }
  if (e.key === 'Escape') closeAddModal();
});

// Auto-expand notes when typing in the title
document.getElementById('addTaskInput').addEventListener('input', (e) => {
  const wrap = document.getElementById('addModalNotesWrap');
  if (e.target.value.trim().length > 0 && !wrap.classList.contains('open') && !store.addTaskAsProject) {
    // Don't auto-expand, user can click notes area or list pill
  }
});

// Auto-add checkbox on Enter in list mode within notes (contenteditable)
document.getElementById('addTaskNotes').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && addTaskListMode) {
    e.preventDefault();
    const el = e.target.closest('#addTaskNotes') || document.getElementById('addTaskNotes');
    // Check if cursor is in an empty checklist line — if so, exit list mode
    const sel = window.getSelection();
    const focusNode = sel.focusNode;
    const line = focusNode ? focusNode.closest ? focusNode.closest('.notes-line') : focusNode.parentElement.closest('.notes-line') : null;
    if (line) {
      const textEl = line.querySelector('.notes-line-text');
      if (textEl && textEl.textContent.replace(/\u200B/g, '').trim() === '') {
        // Empty checklist line — remove it and exit list mode
        line.remove();
        addTaskListMode = false;
        renderAddModalPills();
        return;
      }
    }
    // Insert a new checkbox line
    const newLine = document.createElement('div');
    newLine.className = 'notes-line';
    newLine.contentEditable = 'false';
    newLine.innerHTML = '<span class="cb-visual" onclick="handleInlineCheck(this)"></span><span class="notes-line-text" contenteditable="true">\u200B</span>';
    // Insert after current line or at end
    if (line && line.nextSibling) {
      el.insertBefore(newLine, line.nextSibling);
    } else {
      el.appendChild(newLine);
    }
    // Place cursor in the new line's text span
    const newText = newLine.querySelector('.notes-line-text');
    const range = document.createRange();
    range.setStart(newText, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  if (e.key === 'Escape') closeAddModal();
});


// Close modal on Escape anywhere
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('archivePopup').classList.contains('open')) {
    closeArchivePopup();
    return;
  }
  if (e.key === 'Escape' && document.getElementById('addModal').classList.contains('open')) {
    closeAddModal();
  }
});

function getAndClearAddNotes() {
  const notes = getModalNotesText().trim();
  clearModalNotes();
  document.getElementById('addModalNotesWrap').classList.remove('open');
  addTaskListMode = false;
  return notes;
}

function addTaskToToday() {
  const input = document.getElementById('addTaskInput');
  const title = input.value.trim();
  if (!title) {
    showToast('Type a task first');
    input.focus();
    return;
  }
  const dueDate = store.selectedDueDate || _localDateStr(); // today's date for Today tasks
  const task = api.addTask(
    title,
    '',
    store.selectedRecurring,
    [...store.selectedRecurDays],
    dueDate
  );
  task.notes = getAndClearAddNotes();
  if (store.addTaskAsProject) {
    task.isProject = true;
    if (!task.timeSessions) task.timeSessions = [];
    store.addTaskAsProject = false;
  }
  api.voteUp(task.id);
  input.value = '';
  store.selectedDueDate = null;
  store.selectedRecurring = null;
  store.selectedRecurDays = [];
  render();
  showToast('Added to today');
}

// ─── PUSH POPOVER ───
// ─── JUNK DRAWER ───
function toggleDrawer() {
  // Drawer is now inline — make sure it's uncollapsed and scroll to it
  if (_sectionCollapsed.drawer) {
    _sectionCollapsed.drawer = false;
    applySectionCollapse('drawer');
    try { localStorage.setItem('tinyape-collapsed', JSON.stringify(_sectionCollapsed)); } catch(e) {}
  }
  const section = document.getElementById('drawerSection');
  if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addTaskToDrawer() {
  const input = document.getElementById('addTaskInput');
  const title = input.value.trim();
  if (!title) { showToast('Type a task first'); input.focus(); return; }
  const task = api.addTask(title, '', store.selectedRecurring, [...store.selectedRecurDays], store.selectedDueDate, true);
  task.notes = getAndClearAddNotes();
  input.value = '';
  store.selectedRecurring = null;
  store.selectedRecurDays = [];
  store.selectedDueDate = null;
  render();
  showToast('Added to Drawer');
}

let drawerAddSelectedCat = null;

function addTaskFromDrawer() {
  const input = document.getElementById('drawerAddInput');
  const title = input.value.trim();
  if (!title) return;
  const task = api.addTask(title, '', null, null, null, true);
  // Attach notes
  const notesEl = document.getElementById('drawerAddNotes');
  task.notes = notesEl.value.trim();
  notesEl.value = '';
  // Attach category
  if (drawerAddSelectedCat) {
    task.drawerCategory = drawerAddSelectedCat;
    drawerAddSelectedCat = null;
  }
  input.value = '';
  document.getElementById('drawerAddNotesWrap').style.maxHeight = '0';
  document.getElementById('drawerAddNotesWrap').style.paddingTop = '0';
  drawerListMode = false;
  const listBtn = document.getElementById('drawerAddListBtn');
  if (listBtn) listBtn.classList.remove('active');
  updateDrawerAddCatBtn();
  renderDrawer();
  showToast('Added to Drawer');
}

function cycleDrawerAddCategory() {
  const cats = Object.keys(store.drawerCategories);
  if (!cats.length) return;
  const idx = drawerAddSelectedCat ? cats.indexOf(drawerAddSelectedCat) : -1;
  drawerAddSelectedCat = idx < cats.length - 1 ? cats[idx + 1] : null;
  updateDrawerAddCatBtn();
}

function updateDrawerAddCatBtn() {
  const btn = document.getElementById('drawerAddCatBtn');
  if (!btn) return;
  if (drawerAddSelectedCat && store.drawerCategories[drawerAddSelectedCat]) {
    const cat = store.drawerCategories[drawerAddSelectedCat];
    btn.innerHTML = `<span class="cat-dot" style="background:${cat.color}"></span>${cat.label}`;
    btn.classList.add('active');
  } else {
    btn.innerHTML = '+ category';
    btn.classList.remove('active');
  }
}

let drawerListMode = false;

function toggleDrawerAddList() {
  drawerListMode = !drawerListMode;
  const btn = document.getElementById('drawerAddListBtn');
  btn.classList.toggle('active', drawerListMode);
  const ta = document.getElementById('drawerAddNotes');

  if (drawerListMode) {
    const lines = ta.value.split('\n');
    ta.value = lines.map(l => {
      const trimmed = l.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('[ ] ') || trimmed.startsWith('[x] ')) return l;
      return '[ ] ' + trimmed;
    }).join('\n');
    if (!ta.value.trim()) ta.value = '[ ] ';
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  } else {
    const lines = ta.value.split('\n');
    ta.value = lines.map(l => l.replace(/^\[[ x]\] /, '')).join('\n');
    ta.focus();
  }
}

const _drawerAddNotesEl = document.getElementById('drawerAddNotes');
if (_drawerAddNotesEl) _drawerAddNotesEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && drawerListMode) {
    e.preventDefault();
    const ta = e.target;
    const pos = ta.selectionStart;
    const before = ta.value.substring(0, pos);
    const after = ta.value.substring(ta.selectionEnd);
    const lastLine = before.split('\n').pop();
    if (lastLine.trim() === '[ ]') {
      const newBefore = before.substring(0, before.lastIndexOf('[ ]'));
      ta.value = newBefore + after;
      ta.selectionStart = ta.selectionEnd = newBefore.length;
      drawerListMode = false;
      document.getElementById('drawerAddListBtn').classList.remove('active');
      return;
    }
    ta.value = before + '\n[ ] ' + after;
    ta.selectionStart = ta.selectionEnd = pos + 5;
  }
});

// Drawer input listeners (old slide-out panel — kept for safety, no-ops if element missing)
if (document.getElementById('drawerAddInput')) {
  document.getElementById('drawerAddInput').addEventListener('input', (e) => {
    const wrap = document.getElementById('drawerAddNotesWrap');
    if (!wrap) return;
    if (e.target.value.trim().length > 0) {
      wrap.style.maxHeight = '140px';
      wrap.style.paddingTop = '0';
    } else {
      wrap.style.maxHeight = '0';
      wrap.style.paddingTop = '0';
    }
  });
  document.getElementById('drawerAddInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTaskFromDrawer();
  });
}

function handleMoveToDrawerFromToday(id) {
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;
  api.moveToDrawer(currentId);
  render();
  showToast('Moved to Drawer');
}

function handleMoveToDrawer(id) {
  // Resolve ID — may have changed from integer to UUID after sync
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;
  const row = document.querySelector(`.backlog-item[data-id="${currentId}"]`)
    || document.querySelector(`.backlog-item[data-id="${id}"]`);
  if (row) {
    row.classList.add('slide-to-drawer');
    setTimeout(() => {
      api.moveToDrawer(currentId);
      render();
      showToast('Moved to Drawer');
    }, 350);
  } else {
    api.moveToDrawer(currentId);
    render();
    showToast('Moved to Drawer');
  }
}

function handleDrawerVoteUp(id) {
  api.moveFromDrawer(id);
  api.voteUp(id);
  render();
  showToast('Added to Today');
}

function handleDrawerMoveToOnDeck(id) {
  api.moveFromDrawer(id);
  render();
  showToast('Moved to On Deck');
}

function handleDrawerTrash(id) {
  api.deleteTask(id);
  render();
  showToast('Task killed');
}

let catPopoverEl = null;

function handleSetDrawerCategory(taskId, dotEl) {
  closeCatPopover();
  const cats = store.drawerCategories;
  const keys = Object.keys(cats);
  if (!keys.length) return;

  const rect = dotEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'push-popover';
  pop.style.position = 'fixed';
  pop.style.left = rect.left + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.flexDirection = 'column';
  pop.style.gap = '2px';
  pop.style.padding = '6px';

  const task = store.tasks.find(t => t.id === taskId);
  let popHtml = '';
  keys.forEach(key => {
    const cat = cats[key];
    const isActive = task && task.drawerCategory === key;
    popHtml += `<button onclick="event.stopPropagation();applyDrawerCategory(${taskId},'${key}')" style="display:flex;align-items:center;gap:6px;text-align:left;${isActive ? 'font-weight:700;' : ''}">
      <span class="cat-dot" style="background:${cat.color}"></span>${cat.label}
    </button>`;
  });
  popHtml += `<button onclick="event.stopPropagation();applyDrawerCategory(${taskId},null)" style="color:var(--text-muted);font-size:11px;">✕ None</button>`;
  pop.innerHTML = popHtml;

  document.body.appendChild(pop);
  catPopoverEl = pop;
  setTimeout(() => document.addEventListener('click', closeCatPopoverOnOutside), 0);
}

function applyDrawerCategory(taskId, catKey) {
  if (catPopoverEl) { catPopoverEl.remove(); catPopoverEl = null; }
  document.removeEventListener('click', closeCatPopoverOnOutside);
  api.setTaskDrawerCategory(taskId, catKey);
  renderDrawer();
}

function closeCatPopover() {
  if (catPopoverEl) { catPopoverEl.remove(); catPopoverEl = null; }
  document.removeEventListener('click', closeCatPopoverOnOutside);
}

function closeCatPopoverOnOutside(e) {
  if (catPopoverEl && !catPopoverEl.contains(e.target)) closeCatPopover();
}

// Close cat popover on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && catPopoverEl) closeCatPopover();
});

const catColorOptions = ['#e74c3c','#e67e22','#f39c12','#27ae60','#1abc9c','#3498db','#2456a4','#9b59b6','#34495e','#8B4513'];
let selectedNewCatColor = null;

function handleAddDrawerCategory() {
  // Toggle inline form
  const existing = document.getElementById('drawerCatForm');
  if (existing) { existing.remove(); return; }

  selectedNewCatColor = catColorOptions[Object.keys(store.drawerCategories).length % catColorOptions.length];

  const form = document.createElement('div');
  form.className = 'drawer-cat-form';
  form.id = 'drawerCatForm';

  const colorsHtml = catColorOptions.map(c =>
    `<span class="drawer-cat-color-opt ${c === selectedNewCatColor ? 'selected' : ''}" style="background:${c};" data-color="${c}" onclick="event.stopPropagation(); selectNewCatColor('${c}')"></span>`
  ).join('');

  form.innerHTML = `
    <input type="text" id="newDrawerCatName" placeholder="Category name…" />
    <div class="drawer-cat-colors">${colorsHtml}</div>
    <div class="drawer-cat-form-actions">
      <button class="drawer-cat-form-save" onclick="saveNewDrawerCategory()">Add</button>
      <button class="drawer-cat-form-cancel" onclick="document.getElementById('drawerCatForm').remove()">✕</button>
    </div>
  `;

  const pillsEl = document.getElementById('drawerCatPills');
  pillsEl.insertAdjacentElement('afterend', form);

  document.getElementById('newDrawerCatName').focus();
  document.getElementById('newDrawerCatName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNewDrawerCategory();
    if (e.key === 'Escape') form.remove();
  });
}

function selectNewCatColor(color) {
  selectedNewCatColor = color;
  document.querySelectorAll('.drawer-cat-color-opt').forEach(el => {
    el.classList.remove('selected');
  });
  // Find by data attribute instead of style comparison
  const match = document.querySelector(`.drawer-cat-color-opt[data-color="${color}"]`);
  if (match) match.classList.add('selected');
}

function saveNewDrawerCategory() {
  const input = document.getElementById('newDrawerCatName');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  const key = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const color = selectedNewCatColor || catColorOptions[0];
  api.addDrawerCategory(key, name, color);
  const form = document.getElementById('drawerCatForm');
  if (form) form.remove();
  renderDrawer();
}

function handleDeleteDrawerCategory(key) {
  api.deleteDrawerCategory(key);
  renderDrawer();
}

function handleRenameDrawerCategory(key) {
  const cat = store.drawerCategories[key];
  if (!cat) return;

  // Mobile: open bottom sheet
  if (window.innerWidth <= 640) {
    openCategorySheet(key);
    return;
  }

  // Desktop: inline edit
  const item = document.querySelector(`.drawer-cat-item[data-cat-key="${key}"]`);
  if (!item) return;
  const labelEl = item.querySelector('.cat-label');
  if (!labelEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cat-rename-input';
  input.value = cat.label;
  input.style.cssText = 'width:80px;font-size:13px;padding:1px 4px;border:1px solid var(--accent-red);border-radius:3px;font-family:Inter,sans-serif;background:var(--bg);color:var(--text);outline:none;';

  const save = () => {
    const newName = input.value.trim();
    if (newName && newName !== cat.label) {
      api.renameDrawerCategory(key, newName);
    }
    renderDrawer();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { renderDrawer(); }
  });
  input.addEventListener('blur', save);

  labelEl.replaceWith(input);
  input.focus();
  input.select();
}

// ─── Mobile Category Bottom Sheet ───
function openCategorySheet(key) {
  const cat = store.drawerCategories[key];
  if (!cat) return;

  // Close any existing sheet
  closeCategorySheet();

  const overlay = document.createElement('div');
  overlay.className = 'cat-sheet-overlay';
  overlay.onclick = closeCategorySheet;

  const sheet = document.createElement('div');
  sheet.className = 'cat-sheet';
  sheet.innerHTML = `
    <div class="cat-sheet-handle"></div>
    <div class="cat-sheet-header">
      <span class="cat-dot" style="background:${cat.color};width:10px;height:10px;border-radius:50%;display:inline-block;"></span>
      <span class="cat-sheet-title">Edit Category</span>
    </div>
    <input type="text" class="cat-sheet-input" id="catSheetInput" value="${cat.label.replace(/"/g, '&quot;')}" />
    <div class="cat-sheet-actions">
      <button class="cat-sheet-save" id="catSheetSave">Save</button>
      <button class="cat-sheet-delete" id="catSheetDelete">Delete</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(sheet);

  const input = document.getElementById('catSheetInput');
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCategorySheet(key); }
  });

  document.getElementById('catSheetSave').onclick = () => saveCategorySheet(key);
  document.getElementById('catSheetDelete').onclick = () => {
    api.deleteDrawerCategory(key);
    closeCategorySheet();
    renderDrawer();
  };
}

function saveCategorySheet(key) {
  const input = document.getElementById('catSheetInput');
  if (!input) return;
  const newName = input.value.trim();
  const cat = store.drawerCategories[key];
  if (newName && cat && newName !== cat.label) {
    api.renameDrawerCategory(key, newName);
  }
  closeCategorySheet();
  renderDrawer();
}

function closeCategorySheet() {
  const overlay = document.querySelector('.cat-sheet-overlay');
  const sheet = document.querySelector('.cat-sheet');
  if (overlay) overlay.remove();
  if (sheet) sheet.remove();
}

// Track which drawer groups are open (persists across re-renders)
const drawerGroupOpen = { someday: true };

function toggleDrawerGroup(key) {
  drawerGroupOpen[key] = !drawerGroupOpen[key];
  const group = document.querySelector(`.drawer-group[data-group="${key}"]`);
  if (group) group.classList.toggle('open', drawerGroupOpen[key]);
}

function renderDrawer() {
  const allDrawer = api.getDrawerTasks();
  const cats = store.drawerCategories;

  // Update count in section header
  const countEl = document.getElementById('drawerCount');
  if (countEl) countEl.textContent = allDrawer.length ? `(${allDrawer.length})` : '';

  // Category list — simple inline text with dots
  const pillsEl = document.getElementById('drawerCatPills');
  if (!pillsEl) return;
  let pillsHtml = '';
  const catEntries = Object.entries(cats);
  if (catEntries.length) {
    catEntries.forEach(([key, cat]) => {
      pillsHtml += `<span class="drawer-cat-item" data-cat-key="${key}">
        <span class="cat-dot" style="background:${cat.color};width:6px;height:6px;border-radius:50%;display:inline-block;"></span><span class="cat-label" onclick="handleRenameDrawerCategory('${key}')" title="Click to rename">${cat.label}</span><span class="cat-x" onclick="handleDeleteDrawerCategory('${key}')" title="Remove">✕</span>
      </span>`;
    });
  }
  pillsHtml += `<span class="drawer-cat-add" onclick="handleAddDrawerCategory()">+ add</span>`;
  pillsEl.innerHTML = pillsHtml;

  // Group tasks by category
  const groups = {};
  // Initialize category groups in order
  Object.keys(cats).forEach(key => { groups[key] = []; });
  // Uncategorized = 'someday'
  groups.someday = [];

  allDrawer.forEach(t => {
    const catKey = t.drawerCategory && cats[t.drawerCategory] ? t.drawerCategory : 'someday';
    if (!groups[catKey]) groups[catKey] = [];
    groups[catKey].push(t);
  });

  // Sort within each group: dated tasks first (by date), then undated
  Object.values(groups).forEach(arr => {
    arr.sort((a, b) => {
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      return 0;
    });
  });

  // Render
  const el = document.getElementById('drawerContent');
  let html = '';

  const renderTaskItem = (t) => {
    const due = t.dueDate ? formatDueDate(t.dueDate) : null;
    const recurIcon = t.recurring ? '<span style="color:var(--accent-blue);margin-left:2px;">↻</span>' : '';
    const dateMeta = due ? `<span class="task-due ${due.cls}">${due.text}</span>` : '';
    const notesIcon = t.notes ? '<span class="notes-indicator">📄</span>' : '';

    return `<div class="backlog-item drawer-item" data-id="${t.id}">
      <button class="vote-btn" onclick="handleDrawerMoveToOnDeck(${qid(t.id)})" title="Move to On Deck">
        ${plusSvg}
      </button>
      <span class="backlog-task-title backlog-task-title-clickable" onclick="openNotesSidebar(${qid(t.id)})">${t.title}${notesIcon}${t.isProject ? '<span class="project-indicator">⏱</span>' : (t.timeSessions && t.timeSessions.length) ? '<span class="time-indicator">◷</span>' : ''}${recurIcon}</span>
      ${dateMeta}
      <div class="backlog-actions">
        <button class="remove-btn" onclick="handleDrawerTrash(${qid(t.id)})" title="Delete">✕</button>
      </div>
    </div>`;
  };

  // Render category groups first, then SOMEDAY last
  const catKeys = Object.keys(cats);
  const allGroupKeys = [...catKeys, 'someday'];

  allGroupKeys.forEach(key => {
    const tasks = groups[key] || [];
    if (!tasks.length) return; // Skip empty categories

    // Default all groups to open
    if (!(key in drawerGroupOpen)) drawerGroupOpen[key] = true;
    const isOpen = drawerGroupOpen[key];
    const label = key === 'someday' ? 'SOMEDAY' : cats[key].label.toUpperCase();
    const color = key === 'someday' ? null : cats[key].color;
    const dotHtml = color ? `<span class="cat-dot" style="background:${color}"></span>` : '';

    html += `<div class="drawer-group ${isOpen ? 'open' : ''}" data-group="${key}">
      <div class="drawer-group-header" onclick="toggleDrawerGroup('${key}')">
        <span class="drawer-group-label">${dotHtml}${label}</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="drawer-group-count">${tasks.length}</span>
          <span class="drawer-group-arrow">▾</span>
        </span>
      </div>
      <div class="drawer-group-items">
        ${tasks.map(renderTaskItem).join('')}
      </div>
    </div>`;
  });

  if (allDrawer.length === 0) {
    html = '<div class="drawer-empty" style="text-align:center;padding:24px 0;">Drawer is empty — toss tasks here for later</div>';
  }

  el.innerHTML = html;
}

// Close drawer on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.drawerOpen) toggleDrawer();
});

function toggleRecurPopover(e) {
  e.stopPropagation();
  const pop = document.getElementById('recurPopover');
  pop.classList.toggle('open');
  if (pop.classList.contains('open')) {
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', closeRecurPopover);
    }, 0);
  }
}

function closeRecurPopover(e) {
  const pop = document.getElementById('recurPopover');
  if (pop && !pop.contains(e.target)) {
    pop.classList.remove('open');
    document.removeEventListener('click', closeRecurPopover);
  }
}

function toggleRecurDay(day) {
  const idx = store.selectedRecurDays.indexOf(day);
  if (idx === -1) {
    store.selectedRecurDays.push(day);
    store.selectedRecurDays.sort((a, b) => a - b);
    if (!store.selectedRecurring) store.selectedRecurring = 'weekly';
  } else {
    store.selectedRecurDays.splice(idx, 1);
  }
  renderAddTaskOptions();
  // Re-open popover after re-render
  setTimeout(() => {
    document.getElementById('recurPopover')?.classList.add('open');
  }, 0);
}

function setRecurFreq(freq) {
  store.selectedRecurring = store.selectedRecurring === freq ? null : freq;
  renderAddTaskOptions();
  setTimeout(() => {
    document.getElementById('recurPopover')?.classList.add('open');
  }, 0);
}

function closeRecurOk() {
  const pop = document.getElementById('recurPopover');
  if (pop) pop.classList.remove('open');
  document.removeEventListener('click', closeRecurPopover);
}

function clearRecurring() {
  store.selectedRecurring = null;
  store.selectedRecurDays = [];
  renderAddTaskOptions();
}

function openDatePicker() {
  const picker = document.getElementById('hiddenDatePicker');
  picker.value = store.selectedDueDate || '';
  picker.showPicker ? picker.showPicker() : picker.click();
}

function handleDatePick(val) {
  store.selectedDueDate = val || null;
  renderAddTaskOptions();
}

// ─── ADD-TASK SCHEDULE POPOVER ───
let addTaskSchedProxy = null; // Proxy object for add-task schedule editing

function openAddTaskSchedule(anchorEl) {
  // Close any existing popover first, then set up the proxy
  closeSchedulePopover();
  // Create proxy AFTER close so it doesn't get nuked
  addTaskSchedProxy = {
    id: -1,
    dueDate: store.selectedDueDate || null,
    recurring: store.selectedRecurring || null,
    recurDays: store.selectedRecurDays.length ? [...store.selectedRecurDays] : null
  };
  // Call internal open directly (skip the closeSchedulePopover inside it)
  _openSchedulePopoverInternal(-1, anchorEl);
}

// ─── UNIFIED SCHEDULE POPOVER ───
let schedulePopover = null;
let schedulePopoverTaskId = null;
let scheduleViewMonth = null; // { year, month } for calendar nav
let scheduleShowFullDate = false;
let scheduleAutoRepeat = false; // When true, auto-open repeat section

function openSchedulePopover(taskId, anchorEl) {
  closeSchedulePopover();
  _openSchedulePopoverInternal(taskId, anchorEl);
}

function _openSchedulePopoverInternal(taskId, anchorEl) {
  // Get task object — either a real task or the add-task proxy
  const task = taskId === -1 ? addTaskSchedProxy : store.tasks.find(t => t.id === taskId);
  if (!task) return;
  schedulePopoverTaskId = taskId;
  scheduleShowFullDate = false;

  // Initialize view month to selected date's month, or current month
  const now = new Date();
  if (task.dueDate) {
    const d = new Date(task.dueDate + 'T00:00:00');
    scheduleViewMonth = { year: d.getFullYear(), month: d.getMonth() };
  } else {
    scheduleViewMonth = { year: now.getFullYear(), month: now.getMonth() };
  }

  const pop = document.createElement('div');
  pop.className = 'schedule-popover';
  pop.onclick = (e) => e.stopPropagation();
  document.body.appendChild(pop);
  schedulePopover = { element: pop, taskId, anchor: anchorEl };

  renderSchedulePopover();

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;
  // Keep within viewport
  const popRect = pop.getBoundingClientRect();
  if (left + 270 > window.innerWidth) left = window.innerWidth - 278;
  if (left < 8) left = 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 4;
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';

  // Close on outside click
  setTimeout(() => document.addEventListener('click', handleScheduleOutside), 10);
}

function renderSchedulePopover() {
  if (!schedulePopover) return;
  const pop = schedulePopover.element;
  const task = schedulePopoverTaskId === -1 ? addTaskSchedProxy : store.tasks.find(t => t.id === schedulePopoverTaskId);
  if (!task) return;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayStr = _localDateStr(now);
  const selectedDate = task.dueDate || null;

  const vy = scheduleViewMonth.year;
  const vm = scheduleViewMonth.month;
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Build calendar grid
  const firstDay = new Date(vy, vm, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const dayLabels = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  let calHtml = `<div class="sched-month-header">
    <button class="sched-month-nav" data-dir="prev">‹</button>
    <span>${monthNames[vm]} ${vy}</span>
    <button class="sched-month-nav" data-dir="next">›</button>
  </div>`;
  calHtml += `<div class="sched-days-grid">`;
  dayLabels.forEach(l => { calHtml += `<div class="sched-day-label">${l}</div>`; });
  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) calHtml += `<button class="sched-day empty"></button>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${vy}-${String(vm+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dateObj = new Date(vy, vm, d);
    const isPast = dateObj < now && dateStr !== todayStr;
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === selectedDate;
    const cls = [isSelected ? 'selected' : '', isToday ? 'today' : '', isPast ? 'past' : ''].filter(Boolean).join(' ');
    calHtml += `<button class="sched-day ${cls}" data-date="${dateStr}">${d}</button>`;
  }
  calHtml += `</div>`;

  // Full date input (hidden by default)
  const fullDateHtml = scheduleShowFullDate
    ? `<div class="sched-full-date"><input type="date" id="schedFullDateInput" value="${selectedDate || ''}"></div>`
    : `<div class="sched-more-link" id="schedMoreLink">more dates...</div>`;

  // Repeat section
  const showRepeat = !!task.recurring || scheduleAutoRepeat;
  const hasRepeat = !!task.recurring;
  const currentFreq = task.recurring || 'weekly';
  const currentDays = task.recurDays || [];
  // If auto-repeat was requested, enable recurring
  if (scheduleAutoRepeat && !task.recurring) {
    task.recurring = 'weekly';
    scheduleAutoRepeat = false; // only auto-open once
  }

  let repeatHtml = `<div class="sched-divider"></div>`;
  repeatHtml += `<label class="sched-repeat-toggle"><input type="checkbox" id="schedRepeatCheck" ${hasRepeat || showRepeat ? 'checked' : ''}> Repeats</label>`;
  repeatHtml += `<div class="sched-repeat-section ${hasRepeat || showRepeat ? 'visible' : ''}" id="schedRepeatSection">`;
  repeatHtml += `<div class="sched-label">Frequency</div><div class="recur-freq-row">`;
  ['weekly', 'biweekly', 'monthly', 'annually'].forEach(f => {
    const active = currentFreq === f ? 'active' : '';
    repeatHtml += `<button class="recur-freq ${active}" data-freq="${f}">${f}</button>`;
  });
  repeatHtml += `</div>`;
  // Day pills — only for weekly/biweekly
  const showDays = (currentFreq === 'weekly' || currentFreq === 'biweekly');
  repeatHtml += `<div class="sched-days-pills" id="schedDaysPills" style="${showDays ? '' : 'display:none'}">`;
  repeatHtml += `<div class="sched-label" style="margin-top:8px;">Days</div><div class="recur-days">`;
  for (let i = 0; i < 7; i++) {
    const active = currentDays.includes(i) ? 'active' : '';
    repeatHtml += `<button class="recur-day ${active}" data-day="${i}">${dayShort[i]}</button>`;
  }
  repeatHtml += `</div></div>`;
  repeatHtml += `</div>`;

  // Bottom row
  const bottomHtml = `<div class="recur-bottom-row">
    <button class="recur-clear-btn" id="schedClear">Clear</button>
    <button class="recur-ok-btn" id="schedOk">OK</button>
  </div>`;

  pop.innerHTML = `<button class="popover-close" id="schedClose" title="Close">✕</button>
    <div class="sched-label">Date</div>
    ${calHtml}
    ${fullDateHtml}
    ${repeatHtml}
    ${bottomHtml}`;

  // Wire up events
  pop.querySelector('#schedClose').addEventListener('click', closeSchedulePopover);

  // Calendar day clicks — set date and auto-close
  pop.querySelectorAll('.sched-day:not(.empty):not(.past)').forEach(btn => {
    btn.addEventListener('click', () => {
      task.dueDate = btn.dataset.date;
      const isAddTask = schedulePopoverTaskId === -1;
      const todayStr = _localDateStr();
      const isToday = btn.dataset.date === todayStr;
      closeSchedulePopover();
      if (isAddTask) {
        // Auto-vote-up: if user picks today's date, submit to Today section
        if (isToday) {
          const input = document.getElementById('addTaskInput');
          if (input && input.value.trim()) {
            addModalSubmit('today');
            return;
          }
        }
        renderAddModalPills();
      } else {
        // Existing task: auto-vote-up to Today if today's date selected
        if (isToday && !task.today) {
          api.voteUp(task.id);
          showToast('Moved to Today');
        }
        render();
        if (currentNotesTaskId === task.id) refreshSidebarMeta();
      }
    });
  });

  // Month nav
  pop.querySelectorAll('.sched-month-nav').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.dir === 'prev') {
        scheduleViewMonth.month--;
        if (scheduleViewMonth.month < 0) { scheduleViewMonth.month = 11; scheduleViewMonth.year--; }
      } else {
        scheduleViewMonth.month++;
        if (scheduleViewMonth.month > 11) { scheduleViewMonth.month = 0; scheduleViewMonth.year++; }
      }
      renderSchedulePopover();
    });
  });

  // "more dates..." link
  const moreLink = pop.querySelector('#schedMoreLink');
  if (moreLink) {
    moreLink.addEventListener('click', () => {
      scheduleShowFullDate = true;
      renderSchedulePopover();
    });
  }

  // Full date input
  const fullInput = pop.querySelector('#schedFullDateInput');
  if (fullInput) {
    fullInput.addEventListener('change', () => {
      if (fullInput.value) {
        task.dueDate = fullInput.value;
        const d = new Date(fullInput.value + 'T00:00:00');
        scheduleViewMonth = { year: d.getFullYear(), month: d.getMonth() };
        scheduleShowFullDate = false;
        renderSchedulePopover();
      }
    });
  }

  // Repeat toggle
  const repeatCheck = pop.querySelector('#schedRepeatCheck');
  repeatCheck.addEventListener('change', () => {
    if (repeatCheck.checked) {
      task.recurring = task.recurring || 'weekly';
    } else {
      task.recurring = null;
      task.recurDays = null;
    }
    renderSchedulePopover();
  });

  // Freq buttons
  pop.querySelectorAll('.recur-freq').forEach(btn => {
    btn.addEventListener('click', () => {
      task.recurring = btn.dataset.freq;
      // If switching to monthly/annually, clear day selections
      if (btn.dataset.freq === 'monthly' || btn.dataset.freq === 'annually') {
        task.recurDays = null;
      }
      renderSchedulePopover();
    });
  });

  // Day pills
  pop.querySelectorAll('.recur-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = parseInt(btn.dataset.day);
      let days = task.recurDays ? [...task.recurDays] : [];
      if (days.includes(day)) {
        days = days.filter(d => d !== day);
      } else {
        days.push(day);
        days.sort();
      }
      task.recurDays = days.length ? days : null;
      // Auto-set date to next occurrence of selected day if no date yet
      if (days.length && !task.dueDate) {
        const today = new Date(); today.setHours(0,0,0,0);
        for (let offset = 0; offset <= 7; offset++) {
          const d = new Date(today);
          d.setDate(d.getDate() + offset);
          if (days.includes(d.getDay())) {
            task.dueDate = _localDateStr(d);
            break;
          }
        }
      }
      renderSchedulePopover();
    });
  });

  pop.querySelector('#schedClear').addEventListener('click', () => {
    task.dueDate = null;
    task.recurring = null;
    task.recurDays = null;
    closeSchedulePopover();
    render();
    if (currentNotesTaskId === task.id) refreshSidebarMeta();
    showToast('Date cleared');
  });

  // OK
  pop.querySelector('#schedOk').addEventListener('click', () => {
    // If recurring is set but no date, auto-calculate next date
    if (task.recurring && !task.dueDate) {
      task.dueDate = api._getNextRecurDate(task);
    }
    const todayStr = _localDateStr();
    const isToday = task.dueDate === todayStr;
    // If this is the add-task popover and there's text, auto-add the task
    const isAddTask = schedulePopoverTaskId === -1;
    closeSchedulePopover();
    if (isAddTask) {
      const input = document.getElementById('addTaskInput');
      if (input && input.value.trim()) {
        // Auto-vote-up if date is today
        if (isToday) {
          addModalSubmit('today');
        } else {
          addModalSubmit(addModalDestination);
        }
        return;
      }
    }
    // Existing task: auto-vote-up if date is today
    if (isToday && !task.today) {
      api.voteUp(task.id);
      showToast('Moved to Today');
    }
    render();
    if (currentNotesTaskId === task.id) refreshSidebarMeta();
    const parts = [];
    if (task.dueDate) parts.push('Date set');
    if (task.recurring) parts.push('Repeats ' + task.recurring);
    showToast(parts.length ? parts.join(' · ') : 'No changes');
  });
}

function closeSchedulePopover() {
  // If this was for the add-task proxy, sync back to store
  if (addTaskSchedProxy) {
    store.selectedDueDate = addTaskSchedProxy.dueDate || null;
    store.selectedRecurring = addTaskSchedProxy.recurring || null;
    store.selectedRecurDays = addTaskSchedProxy.recurDays ? [...addTaskSchedProxy.recurDays] : [];
    addTaskSchedProxy = null;
    renderAddTaskOptions();
  }
  scheduleAutoRepeat = false;
  if (schedulePopover) {
    schedulePopover.element.remove();
    schedulePopover = null;
  }
  schedulePopoverTaskId = null;
  document.removeEventListener('click', handleScheduleOutside);
}

function handleScheduleOutside(e) {
  if (schedulePopover && !schedulePopover.element.contains(e.target)) {
    closeSchedulePopover();
    render();
  }
}

// Legacy wrappers — redirect to unified popover
function openInlineDateEdit(taskId, anchorEl) {
  openSchedulePopover(taskId, anchorEl);
}
function openInlineRecurEdit(taskId, anchorEl) {
  openScheduleWithRepeat(taskId, anchorEl);
}

function openScheduleWithRepeat(taskId, anchorEl) {
  scheduleAutoRepeat = true;
  openSchedulePopover(taskId, anchorEl);
}

// Category popover
function toggleCatPopover(e) {
  e.stopPropagation();
  const pop = document.getElementById('catPopover');
  pop.classList.toggle('open');
  if (pop.classList.contains('open')) {
    setTimeout(() => {
      document.addEventListener('click', closeCatPopover);
    }, 0);
  }
}

function closeCatPopover(e) {
  const pop = document.getElementById('catPopover');
  if (pop && !pop.contains(e.target)) {
    pop.classList.remove('open');
    document.removeEventListener('click', closeCatPopover);
  }
}

function selectCategory(key) {
  store.selectedCategory = key;
  renderAddTaskOptions();
}

function handleAddCategoryFromPopover() {
  const nameInput = document.getElementById('popoverCatName');
  const colorInput = document.getElementById('popoverCatColor');
  const name = nameInput.value.trim();
  if (!name) return;
  const key = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (categories[key]) { showToast('Category already exists'); return; }
  categories[key] = { label: name, color: colorInput.value };
  store.selectedCategory = key;
  render();
  showToast(`"${name}" added`);
}

function handleDeleteTask(id) {
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;
  api.deleteTask(currentId);
  render();
  showToast('Task killed');
}

function handleRestoreTask(killedIndex) {
  const task = api.restoreTask(killedIndex);
  if (!task) return;
  render();
  showToast('Task restored');
}

function handleCopyTask(id) {
  const original = store.tasks.find(t => t.id === id);
  if (!original) return;
  const copy = {
    id: store.nextId++,
    title: original.title,
    category: original.category,
    today: original.today,
    todayOrder: null,
    done: false,
    recurring: original.recurring,
    recurDays: original.recurDays ? [...original.recurDays] : null,
    dueDate: original.dueDate,
    projectId: original.projectId,
    notes: original.notes
  };
  // Insert right after the original in the array
  const idx = store.tasks.indexOf(original);
  store.tasks.splice(idx + 1, 0, copy);
  // If it's a today task, re-number
  if (copy.today) {
    api._reorderToday();
  }
  render();
  showToast('Task copied');
}

function handleAddCategory() {
  const nameInput = document.getElementById('newCatName');
  const colorInput = document.getElementById('newCatColor');
  const name = nameInput.value.trim();
  if (!name) return;
  const key = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (categories[key]) { showToast('Category already exists'); return; }
  categories[key] = { label: name, color: colorInput.value };
  render();
  showToast(`"${name}" category added`);
}

function handleDeleteCategory(key) {
  const tasksInCat = store.tasks.filter(t => t.category === key);
  // Uncategorize any tasks in this category
  tasksInCat.forEach(t => t.category = '');
  delete categories[key];
  if (store.selectedCategory === key) store.selectedCategory = '';
  render();
  showToast('Category removed');
}

// Theme toggle — persist to localStorage
document.getElementById('themeToggle').addEventListener('click', () => {
  const body = document.body;
  const isDark = body.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  body.setAttribute('data-theme', newTheme);
  try { localStorage.setItem('tinyape-theme', newTheme); } catch(e) {}
  // Redraw ape with new theme colors
  if (typeof apeEl !== 'undefined' && apeEl) drawPixelApe(apeEl, apeArmFrame || 0);
  // Redraw all creature friends with new theme colors
  if (typeof headerCreatures !== 'undefined') {
    const nowDark = document.body.getAttribute('data-theme') === 'dark';
    headerCreatures.forEach(c => renderSprite(c.el, CREATURE_DEFS[c.defIndex], nowDark));
  }
});
// Restore theme on load (called early to avoid flash)
try {
  const saved = localStorage.getItem('tinyape-theme');
  if (saved) document.body.setAttribute('data-theme', saved);
} catch(e) {}

// ─── COLLAPSIBLE SECTIONS (persistent) ───
let _sectionCollapsed = {};
let _olderHidden = true;
try {
  const sc = localStorage.getItem('tinyape-collapsed');
  if (sc) _sectionCollapsed = JSON.parse(sc);
  _olderHidden = localStorage.getItem('tinyape-older-hidden') !== 'false';
} catch(e) {}

function toggleSectionCollapse(key) {
  _sectionCollapsed[key] = !_sectionCollapsed[key];
  applySectionCollapse(key);
  try { localStorage.setItem('tinyape-collapsed', JSON.stringify(_sectionCollapsed)); } catch(e) {}
}

function applySectionCollapse(key) {
  const section = document.querySelector(`.collapsible-section[data-section="${key}"]`);
  if (!section) return;
  const content = section.querySelector('.section-content');
  const chevron = section.querySelector('.section-chevron');
  if (_sectionCollapsed[key]) {
    if (content) content.style.display = 'none';
    if (chevron) chevron.classList.add('collapsed');
  } else {
    if (content) content.style.display = '';
    if (chevron) chevron.classList.remove('collapsed');
  }
}

function applyAllSectionCollapses() {
  ['projects', 'onDeck', 'drawer'].forEach(applySectionCollapse);
}

function toggleOlderItems() {
  _olderHidden = !_olderHidden;
  try { localStorage.setItem('tinyape-older-hidden', String(_olderHidden)); } catch(e) {}
  render();
}

function applyOlderVisibility() {
  const items = document.querySelectorAll('#backlogList .backlog-item[data-older="true"]');
  items.forEach(el => { el.style.display = _olderHidden ? 'none' : ''; });
}

// Date display
function setDate() {
  const d = new Date();
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  document.getElementById('dateDisplay').textContent = d.toLocaleDateString('en-US', opts);
}

// Toast
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

// ─── NOTES SIDEBAR ───
let currentNotesTaskId = null;
let notesCardEl = null;

function openNotesSidebar(id, anchorEl) {
  // Resolve potentially stale integer ID to current UUID
  const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
  const currentId = task ? task.id : id;

  // If already open for this task, toggle off
  if (currentNotesTaskId === currentId && notesCardEl) {
    closeNotesCard();
    return;
  }
  closeNotesCard(true);  // skip render — we'll open a new card immediately

  if (!task) return;
  currentNotesTaskId = currentId;

  // Find anchor row if not passed
  if (!anchorEl) {
    anchorEl = document.querySelector(`.today-item[data-id="${currentId}"], .backlog-item[data-id="${currentId}"], .drawer-item[data-id="${currentId}"]`)
      || document.querySelector(`.today-item[data-id="${id}"], .backlog-item[data-id="${id}"], .drawer-item[data-id="${id}"]`);
  }

  // Build the card
  const card = document.createElement('div');
  card.className = 'notes-card';
  card.onclick = (e) => e.stopPropagation();

  // Due date display
  const due = task.dueDate ? formatDueDate(task.dueDate) : null;
  const recurLabel = task.recurring ? formatRecurring(task) : null;
  const dayLabels = task.recurDays ? task.recurDays.map(d => dayShort[d]).join(', ') : '';

  let pillsHtml = '';
  // 1. Date pill
  const hasSchedule = due || recurLabel;
  if (hasSchedule) {
    const schedParts = [];
    if (due) schedParts.push(due.text);
    if (recurLabel) schedParts.push('↻');
    pillsHtml += `<span class="notes-card-pill active" onclick="cardEditSchedule(${qid(id)}, this)" title="Edit date">${calIconSvg} ${schedParts.join(' · ')}</span>`;
  } else {
    pillsHtml += `<span class="notes-card-pill" onclick="cardEditSchedule(${qid(id)}, this)" title="Set date">${calIconSvg} Date</span>`;
  }

  // 2. Track pill — available on any task
  const hasTime = (task.timeSessions && task.timeSessions.length > 0) || task.trackTime;
  pillsHtml += `<span class="notes-card-pill${hasTime ? ' active' : ''}" onclick="toggleTimeTracking(${qid(id)})" title="Track time">${trackIconSvg} Track</span>`;

  // 3. Project pill
  pillsHtml += `<span class="notes-card-pill${task.isProject ? ' active' : ''}" onclick="toggleProjectMode(${qid(id)})" title="Toggle project mode">${projectIconSvg} Project</span>`;

  // 4. List pill
  const hasChecklist = task.notes && /^\[ \] |^\[x\] /m.test(task.notes);
  pillsHtml += `<span class="notes-card-pill${hasChecklist ? ' active' : ''}" onclick="toggleChecklistLines(${qid(id)})" title="Add checklist">${checkboxIconSvg} List</span>`;

  // 5. Contextual pill: "On Deck" for Today tasks, "Category" for Drawer tasks, "Drawer" for non-projects
  if (task.today) {
    pillsHtml += `<span class="notes-card-pill" onclick="handleRemoveFromToday(${qid(id)}); closeNotesCard(true);" title="Move to On Deck">${onDeckIconSvg} On Deck</span>`;
  } else if (task.drawer) {
    const catLabel = task.drawerCategory && store.drawerCategories[task.drawerCategory]
      ? store.drawerCategories[task.drawerCategory].label : 'Category';
    pillsHtml += `<span class="notes-card-pill${task.drawerCategory ? ' active' : ''}" onclick="openCardCategoryPicker(${qid(id)}, this)" title="Set category">${categoryIconSvg} ${catLabel}</span>`;
  } else {
    pillsHtml += `<span class="notes-card-pill notes-drawer-pill" onclick="cardMoveToDrawer(${qid(id)})" title="Move to Drawer">${drawerIconSvg} Drawer</span>`;
  }

  // Build progress bar (only for projects with checklist items)
  const progressHtml = renderProgressBarHtml(task);
  // Build time section (for projects OR any task with time tracking enabled)
  const showTime = task.isProject || task.trackTime || (task.timeSessions && task.timeSessions.length > 0);
  const timeHtml = showTime ? renderTimeSectionHtml(task) : '';

  card.innerHTML = `
    <div class="notes-card-header">
      <span class="notes-card-title" contenteditable="true" id="notesTitleEditable" spellcheck="false">${escHtml(task.title)}</span>
      <button class="notes-card-close" onclick="closeNotesCard()">✕</button>
    </div>
    ${progressHtml}
    <div class="notes-textarea" id="notesEditable" contenteditable="true" data-placeholder="Add notes…">${notesTextToHtml(task.notes || '')}</div>
    ${timeHtml}
    <div class="notes-hint-row" id="notesHintRow"><span class="notes-hint-text" id="notesHintText">esc to close</span></div>
    <div class="notes-card-pills">${pillsHtml}</div>
  `;

  // Position card near the task row (desktop only — mobile uses bottom-sheet CSS)
  if (anchorEl && window.innerWidth > 640) {
    const rect = anchorEl.getBoundingClientRect();
    const cardWidth = 420;

    // Append hidden first so we can measure actual card height
    card.style.visibility = 'hidden';
    card.style.animation = 'none';
    document.body.appendChild(card);
    const cardHeight = card.offsetHeight;

    // Horizontal: center on the task row, but keep within viewport
    let left = rect.left + (rect.width / 2) - (cardWidth / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - cardWidth - 8));

    // Vertical: prefer below the task, flip above if not enough room
    let top = rect.bottom + 6;
    let flipped = false;
    if (top + cardHeight > window.innerHeight - 8) {
      top = rect.top - 6 - cardHeight;
      flipped = true;
      // If flipped above but would go off-screen top, clamp to top
      if (top < 8) top = 8;
    }

    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.visibility = '';
    card.style.animation = '';
    // Use appropriate animation direction
    card.style.animation = flipped ? 'noteCardInUp 0.15s ease-out' : 'noteCardIn 0.15s ease-out';
  } else {
    document.body.appendChild(card);
  }
  notesCardEl = card;

  // On mobile, lock body scroll to prevent background scrolling behind the card
  if (window.innerWidth <= 640) {
    window._notesScrollY = window.scrollY;
    document.body.classList.add('notes-open');
    document.body.style.top = `-${window._notesScrollY}px`;
  }

  // Wire up title editing
  const titleEl = card.querySelector('#notesTitleEditable');
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => {
    const newTitle = titleEl.textContent.trim();
    if (newTitle && newTitle !== task.title) {
      task.title = newTitle;
      render();
      // Persist to Supabase via sync layer
      if (window.TinyApeDB) {
        window.TinyApeDB.saveTask(task).catch(err =>
          console.error('Sync error (title edit):', err));
      }
    } else if (!newTitle) {
      titleEl.textContent = task.title; // revert if empty
    }
  });
  // Prevent paste from inserting rich text
  titleEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text.replace(/\n/g, ' '));
  });

  // Wire up contenteditable events
  const editable = card.querySelector('#notesEditable');
  editable.addEventListener('input', () => saveCurrentNotes());
  editable.addEventListener('keydown', handleNotesKeydown);

  // Skip the outer contenteditable as a tab stop — when it receives focus
  // via Tab, immediately redirect into the first .notes-line-text span.
  // This avoids the user having to Tab twice (once to the container, once to text).
  editable.addEventListener('focus', function() {
    const firstTextSpan = editable.querySelector('.notes-line-text');
    if (firstTextSpan) {
      // Use rAF so browser finishes its focus handling first
      requestAnimationFrame(() => {
        firstTextSpan.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(firstTextSpan);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
  });
  setTimeout(() => {
    // On card open, focus the last text span (most natural position)
    const allTextSpans = editable.querySelectorAll('.notes-line-text');
    const lastSpan = allTextSpans.length > 0 ? allTextSpans[allTextSpans.length - 1] : null;
    if (lastSpan) {
      lastSpan.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(lastSpan);
      range.collapse(false); // collapse to end
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editable.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(editable);
      sel.collapseToEnd();
    }
  }, 50);

  // Close on outside click
  setTimeout(() => document.addEventListener('click', handleNotesCardOutside), 10);
}

function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.max(60, el.scrollHeight) + 'px';
}

function closeNotesCard(skipRender) {
  if (notesCardEl && currentNotesTaskId !== null) {
    const task = store.tasks.find(t => t.id === currentNotesTaskId);
    let needsSave = false;
    // Save title if edited
    const titleEl = notesCardEl.querySelector('#notesTitleEditable');
    if (titleEl && task) {
      const newTitle = titleEl.textContent.trim();
      if (newTitle && newTitle !== task.title) {
        task.title = newTitle;
        needsSave = true;
      }
    }
    // Save contenteditable content before destroying the card
    const editable = notesCardEl.querySelector('#notesEditable');
    if (editable && task) {
      const newNotes = notesHtmlToText(editable);
      if (newNotes !== task.notes) { needsSave = true; }
      task.notes = newNotes;
    }
    // Cancel any orphaned debounce timer from saveCurrentNotes sync patch
    if (window._notesSyncTimer) {
      clearTimeout(window._notesSyncTimer);
      window._notesSyncTimer = null;
    }
    // Persist through sync layer (echo suppression + in-flight tracking)
    // instead of direct DB call which caused drawer revert race condition
    if (needsSave && task) {
      if (window._syncSaveTask) {
        window._syncSaveTask(task);
      } else if (window.TinyApeDB) {
        window.TinyApeDB.saveTask(task).catch(err =>
          console.error('Sync error (close notes card):', err));
      }
    }
    notesCardEl.remove();
    notesCardEl = null;
  }
  currentNotesTaskId = null;
  document.removeEventListener('click', handleNotesCardOutside);

  // Restore body scroll on mobile
  if (document.body.classList.contains('notes-open')) {
    document.body.classList.remove('notes-open');
    document.body.style.top = '';
    window.scrollTo(0, window._notesScrollY || 0);
  }

  if (!skipRender) render();
}

function handleNotesCardOutside(e) {
  if (notesCardEl && !notesCardEl.contains(e.target) && !e.target.closest('.schedule-popover')) {
    closeNotesCard();
  }
}

function refreshSidebarMeta() {
  // Refresh by reopening the card in place
  if (currentNotesTaskId === null || !notesCardEl) return;
  const id = currentNotesTaskId;
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;

  // Rebuild just the pills
  const due = task.dueDate ? formatDueDate(task.dueDate) : null;
  const recurLabel = task.recurring ? formatRecurring(task) : null;
  const dayLabels = task.recurDays ? task.recurDays.map(d => dayShort[d]).join(', ') : '';

  let pillsHtml = '';
  // 1. Date pill
  const hasSchedule = due || recurLabel;
  if (hasSchedule) {
    const schedParts = [];
    if (due) schedParts.push(due.text);
    if (recurLabel) schedParts.push('↻');
    pillsHtml += `<span class="notes-card-pill active" onclick="cardEditSchedule(${qid(id)}, this)" title="Edit date">${calIconSvg} ${schedParts.join(' · ')}</span>`;
  } else {
    pillsHtml += `<span class="notes-card-pill" onclick="cardEditSchedule(${qid(id)}, this)" title="Set date">${calIconSvg} Date</span>`;
  }

  // 2. Track pill
  const hasTime2 = (task.timeSessions && task.timeSessions.length > 0) || task.trackTime;
  pillsHtml += `<span class="notes-card-pill${hasTime2 ? ' active' : ''}" onclick="toggleTimeTracking(${qid(id)})" title="Track time">${trackIconSvg} Track</span>`;

  // 3. Project pill
  pillsHtml += `<span class="notes-card-pill${task.isProject ? ' active' : ''}" onclick="toggleProjectMode(${qid(id)})" title="Toggle project mode">${projectIconSvg} Project</span>`;

  // 4. List pill
  const hasChecklist2 = task.notes && /^\[ \] |^\[x\] /m.test(task.notes);
  pillsHtml += `<span class="notes-card-pill${hasChecklist2 ? ' active' : ''}" onclick="toggleChecklistLines(${qid(id)})" title="Add checklist">${checkboxIconSvg} List</span>`;

  // 5. Contextual pill: "On Deck" for Today tasks, "Category" for Drawer tasks, "Drawer" for non-projects
  if (task.today) {
    pillsHtml += `<span class="notes-card-pill" onclick="handleRemoveFromToday(${qid(id)}); closeNotesCard(true);" title="Move to On Deck">${onDeckIconSvg} On Deck</span>`;
  } else if (task.drawer) {
    const catLabel = task.drawerCategory && store.drawerCategories[task.drawerCategory]
      ? store.drawerCategories[task.drawerCategory].label : 'Category';
    pillsHtml += `<span class="notes-card-pill${task.drawerCategory ? ' active' : ''}" onclick="openCardCategoryPicker(${qid(id)}, this)" title="Set category">${categoryIconSvg} ${catLabel}</span>`;
  } else {
    pillsHtml += `<span class="notes-card-pill notes-drawer-pill" onclick="cardMoveToDrawer(${qid(id)})" title="Move to Drawer">${drawerIconSvg} Drawer</span>`;
  }

  const pillsContainer = notesCardEl.querySelector('.notes-card-pills');
  if (pillsContainer) pillsContainer.innerHTML = pillsHtml;
}

function openCardCategoryPicker(taskId, pillEl) {
  // Toggle accordion inline inside the notes card
  const existing = notesCardEl && notesCardEl.querySelector('.card-cat-accordion');
  if (existing) { existing.remove(); return; }
  if (!notesCardEl) return;

  const cats = store.drawerCategories;
  const keys = Object.keys(cats);
  const task = store.tasks.find(t => t.id === taskId);

  let itemsHtml = '';
  keys.forEach(key => {
    const cat = cats[key];
    const isActive = task && task.drawerCategory === key;
    itemsHtml += `<button class="card-cat-item${isActive ? ' active' : ''}" onclick="event.stopPropagation();applyCardCategory(${qid(taskId)},'${key}')">
      <span class="card-cat-dot" style="background:${cat.color}"></span>
      <span class="card-cat-label">${escHtml(cat.label)}</span>
      ${isActive ? '<span class="card-cat-check">✓</span>' : ''}
    </button>`;
  });
  // "None" option to clear category
  const noneActive = task && !task.drawerCategory;
  itemsHtml += `<button class="card-cat-item card-cat-none${noneActive ? ' active' : ''}" onclick="event.stopPropagation();applyCardCategory(${qid(taskId)},null)">
    <span class="card-cat-dot" style="background:var(--border)"></span>
    <span class="card-cat-label">None</span>
    ${noneActive ? '<span class="card-cat-check">✓</span>' : ''}
  </button>`;

  const accordion = document.createElement('div');
  accordion.className = 'card-cat-accordion';
  accordion.innerHTML = `<div class="card-cat-list">${itemsHtml}</div>`;

  // Insert before the pills row
  const pillsRow = notesCardEl.querySelector('.notes-card-pills');
  if (pillsRow) pillsRow.insertAdjacentElement('beforebegin', accordion);
}

function applyCardCategory(taskId, catKey) {
  api.setTaskDrawerCategory(taskId, catKey);
  // Remove accordion
  if (notesCardEl) {
    const acc = notesCardEl.querySelector('.card-cat-accordion');
    if (acc) acc.remove();
  }
  refreshSidebarMeta();
  renderDrawer();
}

// ─── PROJECT & TIME TRACKING ───
function formatMinutes(mins) {
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderProgressBarHtml(task) {
  if (!task.isProject) return '';
  const copyBtn = `<button class="notes-copy-btn" onclick="copyProjectToClipboard(${qid(task.id)})" title="Copy project to clipboard">${copyIconSvg}</button>`;
  const prog = api.getChecklistProgress(task.id);
  if (prog.total === 0) return `<div class="notes-progress-row">${copyBtn}</div>`;
  const pct = Math.round((prog.checked / prog.total) * 100);
  return `<div class="notes-progress-row">
    <div class="notes-progress-bar"><div class="notes-progress-fill" style="width:${pct}%"></div></div>
    <span class="notes-progress-label">${prog.checked}/${prog.total}</span>
    ${copyBtn}
  </div>`;
}

function renderTimeSectionHtml(task) {
  const sessions = task.timeSessions || [];
  const totalMins = sessions.reduce((sum, s) => sum + s.minutes, 0);

  let sessionsHtml = '';
  sessions.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach((s, idx) => {
    const d = new Date(s.date + 'T00:00:00');
    sessionsHtml += `<div class="time-session-item" data-session-idx="${idx}" onclick="editTimeSession(${qid(task.id)}, ${idx})">
      <span class="time-session-date">${fmtDate(d)}</span>
      <span class="time-session-duration">${formatMinutes(s.minutes)}</span>
      <span class="time-session-note">${s.note || ''}</span>
      <span class="time-session-delete" onclick="event.stopPropagation(); deleteTimeSession(${qid(task.id)}, ${idx})">✕</span>
    </div>`;
  });

  const todayStr = _localDateStr();

  return `<div class="time-section" id="timeSection">
    <div class="time-section-header">
      ⏱ Time${totalMins ? ' — <span class="time-total">' + formatMinutes(totalMins) + ' total</span>' : ''}
    </div>
    ${sessionsHtml ? `<div class="time-session-list" id="timeSessionList">${sessionsHtml}</div>` : ''}
    <div class="time-edit-form" id="timeEditForm" style="display:none;">
      <div class="time-save-row">
        <input type="date" class="time-date-input" id="timeEditDate" value="" />
      </div>
      <div class="time-slider-row">
        <input type="range" class="time-slider" id="timeEditSlider" min="15" max="480" step="15" value="15"
               oninput="document.getElementById('timeEditSliderLabel').textContent = formatMinutes(parseInt(this.value))">
        <span class="time-slider-label" id="timeEditSliderLabel">15m</span>
      </div>
      <textarea class="time-note-input" id="timeEditNote" placeholder="What did you work on? (optional)" rows="2"></textarea>
      <div class="time-save-row">
        <button class="time-save-btn" onclick="saveTimeSessionEdit()">Save</button>
        <button class="time-cancel-btn" onclick="cancelTimeSessionEdit()">Cancel</button>
      </div>
    </div>
    <button class="time-add-pill" onclick="toggleTimeAddForm()" id="timeAddPill">+ Add session</button>
    <div class="time-add-form" id="timeAddForm" style="display:none;">
      <div class="time-save-row">
        <input type="date" class="time-date-input" id="timeSessionDate" value="${todayStr}" />
      </div>
      <div class="time-slider-row">
        <input type="range" class="time-slider" id="timeSlider" min="15" max="480" step="15" value="15"
               oninput="document.getElementById('timeSliderLabel').textContent = formatMinutes(parseInt(this.value))">
        <span class="time-slider-label" id="timeSliderLabel">15m</span>
      </div>
      <textarea class="time-note-input" id="timeSessionNote" placeholder="What did you work on? (optional)" rows="2"></textarea>
      <div class="time-save-row">
        <button class="time-save-btn" onclick="saveTimeSession()">Save</button>
      </div>
    </div>
  </div>`;
}

// Track which session is being edited
let _editingSessionIdx = null;

function editTimeSession(taskId, idx) {
  const task = store.tasks.find(t => t.id === taskId);
  if (!task || !task.timeSessions) return;
  const sorted = task.timeSessions.slice().sort((a, b) => b.date.localeCompare(a.date));
  const session = sorted[idx];
  if (!session) return;

  _editingSessionIdx = idx;

  // Highlight the active row
  document.querySelectorAll('.time-session-item').forEach(el => el.classList.remove('editing'));
  const row = document.querySelector(`.time-session-item[data-session-idx="${idx}"]`);
  if (row) row.classList.add('editing');

  // Show edit form, hide add form and add pill
  const editForm = document.getElementById('timeEditForm');
  const addForm = document.getElementById('timeAddForm');
  const addPill = document.getElementById('timeAddPill');
  if (addForm) addForm.style.display = 'none';
  if (addPill) addPill.style.display = 'none';
  if (editForm) {
    editForm.style.display = 'block';
    document.getElementById('timeEditDate').value = session.date;
    const slider = document.getElementById('timeEditSlider');
    slider.value = session.minutes;
    document.getElementById('timeEditSliderLabel').textContent = formatMinutes(session.minutes);
    document.getElementById('timeEditNote').value = session.note || '';
    setTimeout(() => document.getElementById('timeEditNote').focus(), 50);
  }
}

function saveTimeSessionEdit() {
  if (currentNotesTaskId === null || _editingSessionIdx === null) return;
  const date = document.getElementById('timeEditDate').value;
  const minutes = parseInt(document.getElementById('timeEditSlider').value);
  const note = document.getElementById('timeEditNote').value.trim();

  if (api.updateTimeSession) {
    api.updateTimeSession(currentNotesTaskId, _editingSessionIdx, { date, minutes, note });
  } else {
    // Fallback if sync hasn't patched it — update locally
    const task = store.tasks.find(t => t.id === currentNotesTaskId);
    if (task && task.timeSessions) {
      const sorted = task.timeSessions.slice().sort((a, b) => b.date.localeCompare(a.date));
      const session = sorted[_editingSessionIdx];
      if (session) {
        session.date = date;
        session.minutes = minutes;
        session.note = note;
      }
    }
  }

  _editingSessionIdx = null;
  // Refresh the notes card to show updated data
  const id = currentNotesTaskId;
  closeNotesCard();
  openNotesSidebar(id);
  showToast('Session updated');
}

function cancelTimeSessionEdit() {
  _editingSessionIdx = null;
  const editForm = document.getElementById('timeEditForm');
  const addPill = document.getElementById('timeAddPill');
  if (editForm) editForm.style.display = 'none';
  if (addPill) addPill.style.display = '';
  document.querySelectorAll('.time-session-item').forEach(el => el.classList.remove('editing'));
}

function toggleTimeAddForm() {
  const form = document.getElementById('timeAddForm');
  if (!form) return;
  // Close any edit in progress
  cancelTimeSessionEdit();
  const opening = form.style.display === 'none';
  form.style.display = opening ? 'block' : 'none';
  if (opening) {
    const noteInput = document.getElementById('timeSessionNote');
    if (noteInput) setTimeout(() => noteInput.focus(), 50);
  }
}

function saveTimeSession() {
  if (currentNotesTaskId === null) return;
  const date = document.getElementById('timeSessionDate').value;
  const minutes = parseInt(document.getElementById('timeSlider').value);
  const note = document.getElementById('timeSessionNote').value.trim();
  api.addTimeSession(currentNotesTaskId, date, minutes, note);
  // Re-open the notes card to refresh everything
  const id = currentNotesTaskId;
  closeNotesCard();
  openNotesSidebar(id);
  showToast(`Logged ${formatMinutes(minutes)}`);
}

function deleteTimeSession(taskId, idx) {
  api.deleteTimeSession(taskId, idx);
  if (currentNotesTaskId === taskId) {
    closeNotesCard();
    openNotesSidebar(taskId);
  }
}

function toggleProjectMode(id) {
  api.toggleProject(id);
  const task = store.tasks.find(t => t.id === id);
  showToast(task && task.isProject ? 'Project mode on' : 'Project mode off');
  // Render first so the DOM reflects the new section membership,
  // then reopen the card on the freshly-rendered anchor row
  closeNotesCard();
  render();
  openNotesSidebar(id);
}

function toggleTimeTracking(id) {
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;
  task.trackTime = !task.trackTime;
  if (!task.timeSessions) task.timeSessions = [];

  // Toggle time section inline (accordion) without reopening the card
  if (notesCardEl) {
    const existingTime = notesCardEl.querySelector('#timeSection');
    if (task.trackTime || task.isProject || (task.timeSessions && task.timeSessions.length > 0)) {
      // Show time section
      if (!existingTime) {
        const timeHtml = renderTimeSectionHtml(task);
        const insertPoint = notesCardEl.querySelector('.notes-card-pills');
        if (insertPoint) insertPoint.insertAdjacentHTML('beforebegin', timeHtml);
      }
    } else {
      // Hide time section
      if (existingTime) existingTime.remove();
    }
    // Update pill active state
    refreshSidebarMeta(id);
  }

  showToast(task.trackTime ? 'Time tracking on' : 'Time tracking off');
}

function cardVoteUp(id) {
  api.voteUp(id);
  render();
  refreshSidebarMeta();
  showToast('Added to Today');
}

function cardMoveToDrawer(id) {
  closeNotesCard();
  const task = store.tasks.find(t => t.id === id);
  if (task && task.today) {
    handleMoveToDrawerFromToday(id);
  } else {
    handleMoveToDrawer(id);
  }
}

// ─── CHECKLIST / NOTES (inline contenteditable with checkboxes) ───

// Convert task.notes plain text → HTML for contenteditable
// Uses <span> for checkboxes instead of <input> to prevent browser
// Tab focus from landing before checkbox elements.
// Each .notes-line is contenteditable="false" with only .notes-line-text
// set to contenteditable="true" — this makes it structurally impossible
// for the caret to land between the checkbox and the text.
function notesTextToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  return lines.map(line => {
    const unchecked = line.match(/^\[ \] (.*)$/);
    const checked = line.match(/^\[x\] (.*)$/);
    if (unchecked) {
      const txt = escHtml(unchecked[1]) || '\u200B';
      return `<div class="notes-line" contenteditable="false"><span class="cb-visual" onclick="handleInlineCheck(this)"></span><span class="notes-line-text" contenteditable="true">${txt}</span></div>`;
    } else if (checked) {
      const txt = escHtml(checked[1]) || '\u200B';
      return `<div class="notes-line checked" contenteditable="false"><span class="cb-visual checked" onclick="handleInlineCheck(this)"></span><span class="notes-line-text" contenteditable="true">${txt}</span></div>`;
    } else {
      return `<div>${escHtml(line) || '<br>'}</div>`;
    }
  }).join('');
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert contenteditable HTML → plain text for task.notes
function notesHtmlToText(container) {
  const lines = [];
  container.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      lines.push(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList && node.classList.contains('notes-line')) {
      const cb = node.querySelector('.cb-visual') || node.querySelector('input[type="checkbox"]');
      const textEl = node.querySelector('.notes-line-text');
      const text = textEl ? textEl.textContent.replace(/\u200B/g, '') : '';
      const isChecked = cb ? (cb.classList ? cb.classList.contains('checked') : cb.checked) : false;
      const prefix = isChecked ? '[x] ' : '[ ] ';
      lines.push(prefix + text);
    } else {
      // Regular line (div, p, or bare text)
      const text = node.textContent.replace(/\u200B/g, '');
      lines.push(text === '\n' ? '' : text);
    }
  });
  // Handle case where contenteditable is just bare text with no child divs
  if (lines.length === 0 && container.childNodes.length === 0) {
    return (container.textContent || '').replace(/\u200B/g, '');
  }
  return lines.join('\n');
}

// Handle checkbox click inside contenteditable
// Works with both <span class="cb-visual"> and legacy <input type="checkbox">
function handleInlineCheck(cb) {
  const line = cb.closest('.notes-line');
  if (!line) return;
  // Toggle checked state — span-based checkboxes use classList, input-based use .checked
  const isInput = cb.tagName === 'INPUT';
  let wasChecked;
  if (isInput) {
    wasChecked = cb.checked;
    if (wasChecked) { line.classList.add('checked'); } else { line.classList.remove('checked'); }
  } else {
    // Span-based: toggle the class
    wasChecked = !cb.classList.contains('checked');
    cb.classList.toggle('checked');
    if (wasChecked) { line.classList.add('checked'); } else { line.classList.remove('checked'); }
  }
  // If in add-modal, no need to save/render
  if (cb.closest('#addTaskNotes')) return;
  saveCurrentNotes();
  render();

  // Project sub-item: update progress bar in notes card + counter/HoF
  if (currentNotesTaskId) {
    const task = store.tasks.find(t => t.id === currentNotesTaskId);
    if (task && task.isProject) {
      // Update progress bar inside the open notes card
      const progRow = document.querySelector('.notes-progress-row');
      if (progRow) {
        const prog = api.getChecklistProgress(task.id);
        if (prog.total > 0) {
          const pct = Math.round((prog.checked / prog.total) * 100);
          const fill = progRow.querySelector('.notes-progress-fill');
          const label = progRow.querySelector('.notes-progress-label');
          if (fill) fill.style.width = pct + '%';
          if (label) label.textContent = prog.checked + '/' + prog.total;
        }
      }
      if (wasChecked) {
        // Checked: mini reward (confetti + ape jump) — no counter/HOF increment for sub-items
        miniReward();
      }
    }
  }
}

// Handle Enter key inside checklist lines — auto-add new checkbox
function handleNotesKeydown(e) {
  if (e.key !== 'Enter') return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.anchorNode;
  const lineEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const notesLine = lineEl.closest('.notes-line');
  if (!notesLine) return; // Normal text — let browser handle

  e.preventDefault();
  const textEl = notesLine.querySelector('.notes-line-text');
  const lineText = textEl ? textEl.textContent.replace(/\u200B/g, '') : '';

  // Check if the current line text is empty — if so, break out of checklist
  // But only if there are other checklist lines (don't break out of a fresh single line)
  if (lineText.trim() === '') {
    const allCheckLines = notesLine.parentElement.querySelectorAll('.notes-line');
    if (allCheckLines.length > 1) {
      // Replace checklist line with empty plain div
      const newDiv = document.createElement('div');
      newDiv.innerHTML = '<br>';
      notesLine.replaceWith(newDiv);
      const range = document.createRange();
      range.setStart(newDiv, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      saveCurrentNotes();
      return;
    }
  }

  // Split text at cursor and create new checklist line
  const range = sel.getRangeAt(0);
  // Figure out cursor offset within the text content
  let offset = 0;
  if (range.startContainer === textEl) {
    // Cursor is on the span itself, use child offset
    offset = range.startOffset > 0 ? textEl.textContent.length : 0;
  } else if (range.startContainer.nodeType === Node.TEXT_NODE && textEl.contains(range.startContainer)) {
    // Walk text nodes to find absolute offset
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    let n;
    while (n = walker.nextNode()) {
      if (n === range.startContainer) { offset += range.startOffset; break; }
      offset += n.textContent.length;
    }
  } else {
    offset = lineText.length;
  }

  const fullText = lineText;
  const before = fullText.slice(0, offset);
  const after = fullText.slice(offset);

  textEl.textContent = before || '\u200B';

  const newLine = document.createElement('div');
  newLine.className = 'notes-line';
  newLine.contentEditable = 'false';
  const newCb = document.createElement('span');
  newCb.className = 'cb-visual';
  newCb.onclick = function() { handleInlineCheck(this); };
  const newTextSpan = document.createElement('span');
  newTextSpan.className = 'notes-line-text';
  newTextSpan.contentEditable = 'true';
  // Use a zero-width space if empty so cursor can land in the span
  newTextSpan.textContent = after || '\u200B';
  newLine.appendChild(newCb);
  newLine.appendChild(newTextSpan);
  notesLine.insertAdjacentElement('afterend', newLine);

  // Place cursor at start of new line text span
  const newRange = document.createRange();
  newRange.setStart(newTextSpan.firstChild, after ? 0 : 1);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  saveCurrentNotes();
}

// Toggle checklist on selected/current lines
function toggleChecklistLines(taskId) {
  const editable = document.getElementById('notesEditable');
  if (!editable) return;

  // Save current state first
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.notes = notesHtmlToText(editable);

  const lines = task.notes.split('\n');
  const allChecklist = lines.length > 0 && lines.every(l => l.startsWith('[ ] ') || l.startsWith('[x] ') || l.trim() === '');

  if (allChecklist && lines.some(l => l.startsWith('[ ] ') || l.startsWith('[x] '))) {
    // Remove all checklist prefixes
    task.notes = lines.map(l => {
      if (l.startsWith('[ ] ')) return l.slice(4);
      if (l.startsWith('[x] ')) return l.slice(4);
      return l;
    }).join('\n');
  } else {
    // Add checklist prefix to all non-empty lines, or start fresh
    if (task.notes.trim() === '') {
      task.notes = '[ ] ';
    } else {
      task.notes = lines.map(l => {
        if (l.trim() === '') return l;
        if (l.startsWith('[ ] ') || l.startsWith('[x] ')) return l;
        return '[ ] ' + l;
      }).join('\n');
    }
  }

  // Re-render
  editable.innerHTML = notesTextToHtml(task.notes);
  editable.focus();
  // Place cursor inside the last text span (after the checkbox, not before it)
  const lastTextSpan = editable.querySelector('.notes-line:last-child .notes-line-text');
  if (lastTextSpan) {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(lastTextSpan);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Update the List pill active state
  const listPill = notesCardEl && notesCardEl.querySelector('.notes-card-pill:last-child');
  const nowHasChecklist = /^\[ \] |^\[x\] /m.test(task.notes);
  if (listPill) {
    listPill.classList.toggle('active', nowHasChecklist);
  }

  saveCurrentNotes();
}

function cardEditDate(id, anchorEl) {
  openSchedulePopover(id, anchorEl);
}

function cardEditRecur(id, anchorEl) {
  openSchedulePopover(id, anchorEl);
}

function cardEditSchedule(id, anchorEl) {
  openSchedulePopover(id, anchorEl);
}

function cardClearSchedule(id) {
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;
  task.dueDate = null;
  task.recurring = null;
  task.recurDays = null;
  render();
  refreshSidebarMeta();
  showToast('Date cleared');
}

function cardClearDate(id) {
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;
  task.dueDate = null;
  render();
  refreshSidebarMeta();
  showToast('Date removed');
}

function cardClearRecur(id) {
  const task = store.tasks.find(t => t.id === id);
  if (!task) return;
  task.recurring = null;
  task.recurDays = null;
  render();
  refreshSidebarMeta();
  showToast('Recurring removed');
}

let notesSaveTimer = null;
function saveCurrentNotes() {
  if (currentNotesTaskId === null) return;
  const task = store.tasks.find(t => t.id === currentNotesTaskId);
  if (task) {
    const editable = document.getElementById('notesEditable');
    if (editable) task.notes = notesHtmlToText(editable);
  }
  // Show "auto-saved ✓" immediately, then revert to "esc to close"
  clearTimeout(notesSaveTimer);
  const hint = document.getElementById('notesHintText');
  if (hint) {
    hint.textContent = 'auto-saved ✓';
    hint.classList.add('saved');
    notesSaveTimer = setTimeout(() => {
      hint.textContent = 'esc to close';
      hint.classList.remove('saved');
    }, 1200);
  }
}

// Close popovers on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Schedule popover takes priority (it may be open on top of notes card)
    if (schedulePopover) {
      closeSchedulePopover();
      render();
      return;
    }
    if (currentNotesTaskId !== null) {
      closeNotesCard();
    }
  }
});

// ─── INLINE RECURRING EDIT ───
let inlineRecurPopover = null;

// Old recur popover removed — unified into openSchedulePopover above

// ─── DRAG REORDER (smooth, transform-based) ───
let dragItem = null;
let dragStartY = 0;
let dragOffsetY = 0;
let dragHasMoved = false;
let dragOrder = [];   // current visual order of task IDs
let dragItemH = 0;
let dragListId = 'todayList'; // which list is being dragged in

function startDrag(item, startY, listId) {
  dragItem = item;
  dragStartY = startY;
  dragOffsetY = 0;
  dragHasMoved = false;
  dragItemH = item.offsetHeight;
  dragListId = listId || 'todayList';

  // Snapshot current order from the correct list
  const container = document.getElementById(dragListId);
  dragOrder = [...container.querySelectorAll('.today-item, .project-row')].map(el => parseInt(el.dataset.id));

  dragItem.classList.add('dragging');
}

function moveDrag(clientY) {
  if (!dragItem) return;
  dragHasMoved = true;
  dragOffsetY = clientY - dragStartY;

  // Move dragged item visually
  dragItem.style.transform = `translateY(${dragOffsetY}px)`;

  // Figure out how many positions we've crossed
  const container = document.getElementById(dragListId);
  const items = [...container.querySelectorAll('.today-item, .project-row')];
  const dragIdx = items.indexOf(dragItem);
  const positions = Math.round(dragOffsetY / dragItemH);
  const targetIdx = Math.max(0, Math.min(items.length - 1, dragIdx + positions));

  // Shift other items to make room
  items.forEach((el, i) => {
    if (el === dragItem) return;
    el.classList.add('drag-swap');
    if (dragIdx < targetIdx && i > dragIdx && i <= targetIdx) {
      el.style.transform = `translateY(${-dragItemH}px)`;
    } else if (dragIdx > targetIdx && i >= targetIdx && i < dragIdx) {
      el.style.transform = `translateY(${dragItemH}px)`;
    } else {
      el.style.transform = '';
    }
  });
}

function endDrag() {
  if (!dragItem) return;

  // Calculate final position
  const container = document.getElementById(dragListId);
  const items = [...container.querySelectorAll('.today-item, .project-row')];
  const dragIdx = items.indexOf(dragItem);
  const positions = Math.round(dragOffsetY / dragItemH);
  const targetIdx = Math.max(0, Math.min(items.length - 1, dragIdx + positions));

  // Clear all transforms
  items.forEach(el => {
    el.classList.remove('drag-swap', 'dragging');
    el.style.transform = '';
  });

  // Perform actual DOM reorder if position changed
  if (dragIdx !== targetIdx && dragHasMoved) {
    const parent = dragItem.parentNode;
    if (targetIdx > dragIdx) {
      const ref = items[targetIdx];
      parent.insertBefore(dragItem, ref.nextSibling);
    } else {
      parent.insertBefore(dragItem, items[targetIdx]);
    }
    saveOrder();
  }

  dragItem = null;
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  if (dragHasMoved) render();
}

function onMouseMove(e) { e.preventDefault(); moveDrag(e.clientY); }
function onMouseUp() { endDrag(); }

// Drag setup helper for any sortable list
function setupDragList(listId) {
  const el = document.getElementById(listId);
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.drag-handle')) return;
    const item = e.target.closest('.today-item, .project-row');
    if (!item) return;
    e.preventDefault();
    startDrag(item, e.clientY, listId);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  el.addEventListener('touchstart', (e) => {
    if (!e.target.closest('.drag-handle')) return;
    const item = e.target.closest('.today-item, .project-row');
    if (!item) return;
    startDrag(item, e.touches[0].clientY, listId);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!dragItem) return;
    e.preventDefault();
    moveDrag(e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (dragItem) endDrag();
  });
}

setupDragList('todayList');
setupDragList('projectsList');

function saveOrder() {
  const container = document.getElementById(dragListId);
  const items = [...container.querySelectorAll('.today-item, .project-row')];
  const ids = items.map(el => el.dataset.id);
  if (dragListId === 'projectsList') {
    api.reorderProjects(ids);
  } else {
    api.reorderToday(ids);
  }
  items.forEach((el, i) => {
    const numEl = el.querySelector('.today-number');
    if (numEl) numEl.textContent = i + 1;
  });
}

// ─── PIXEL APE MASCOT ───
// Frame 0 = arms down (resting), Frame 1 = left arm up / right down, Frame 2 = right arm up / left down
function drawPixelApe(canvas, frame) {
  frame = frame || 0;
  const ctx = canvas.getContext('2d');
  const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };
  ctx.clearRect(0, 0, 24, 24);

  const isDark = document.body.getAttribute('data-theme') === 'dark';
  const brown = isDark ? '#f5e6d0' : '#8B4513';
  const dark  = isDark ? '#b8a080' : '#5C2D0A';
  const tan   = isDark ? '#c8b89a' : '#D2A068';
  const eye   = isDark ? '#3a2a1a' : '#ffffff';
  const pupil = isDark ? '#f5f0e6' : '#1a1a1a';

  // Head
  [9,10,11,12,13,14].forEach(x => { px(x, 6, brown); px(x, 7, brown); });
  [8,15].forEach(x => { px(x, 7, brown); px(x, 8, brown); });
  [8,9,10,11,12,13,14,15].forEach(x => px(x, 8, brown));
  [8,9,10,11,12,13,14,15].forEach(x => px(x, 9, brown));

  // Face
  [9,10,11,12,13,14].forEach(x => px(x, 10, tan));
  [10,11,12,13].forEach(x => px(x, 11, tan));

  // Eyes
  px(10, 9, eye); px(11, 9, pupil);
  px(13, 9, eye); px(14, 9, pupil);

  // Mouth
  px(11, 11, dark); px(12, 11, dark);

  // Ears with inner detail
  px(7, 8, brown); px(7, 9, dark);
  px(16, 8, brown); px(16, 9, dark);

  // Body with round darker belly
  [9,10,11,12,13,14].forEach(x => px(x, 12, brown));
  [9,14].forEach(x => px(x, 13, brown));
  [10,11,12,13].forEach(x => px(x, 13, dark));  // belly top
  [9,14].forEach(x => px(x, 14, brown));
  [10,11,12,13].forEach(x => px(x, 14, dark));  // belly mid
  [9,14].forEach(x => px(x, 15, brown));
  [10,11,12,13].forEach(x => px(x, 15, dark));  // belly bottom
  [10,11,12,13].forEach(x => px(x, 16, brown));

  // Arms — alternate positions per frame for walk cycle
  if (frame === 1) {
    // Left arm UP, right arm DOWN
    px(7, 11, brown); px(6, 10, brown); px(5, 9, brown);   // left up
    px(16, 12, brown); px(17, 13, brown); px(18, 14, brown); // right down
  } else if (frame === 2) {
    // Left arm DOWN, right arm UP
    px(7, 12, brown); px(6, 13, brown); px(5, 14, brown);   // left down
    px(16, 11, brown); px(17, 10, brown); px(18, 9, brown);  // right up
  } else {
    // Resting — both arms at sides
    px(7, 12, brown); px(6, 13, brown); px(5, 14, brown);
    px(16, 12, brown); px(17, 13, brown); px(18, 14, brown);
  }

  // Tail — swings with walk frames
  if (frame === 1) {
    // Tail up
    px(15, 15, brown); px(16, 14, brown); px(17, 13, brown); px(18, 12, brown);
  } else if (frame === 2) {
    // Tail down
    px(15, 15, brown); px(16, 16, brown); px(17, 17, brown); px(18, 18, brown);
  } else {
    // Tail resting — slight curl out
    px(15, 15, brown); px(16, 15, brown); px(17, 14, brown); px(18, 13, brown);
  }

  // Legs
  px(10, 17, brown); px(10, 18, brown); px(9, 19, dark); px(10, 19, dark);
  px(13, 17, brown); px(13, 18, brown); px(13, 19, dark); px(14, 19, dark);
}

let apeArmFrame = 0;
let apeArmInterval = null;

function startApeArmSwing() {
  if (apeArmInterval) return;
  apeArmFrame = 1;
  apeArmInterval = setInterval(() => {
    apeArmFrame = apeArmFrame === 1 ? 2 : 1;
    drawPixelApe(apeEl, apeArmFrame);
  }, 200);  // swap arms every 200ms for a nice waddle
}

function stopApeArmSwing() {
  if (apeArmInterval) {
    clearInterval(apeArmInterval);
    apeArmInterval = null;
  }
  apeArmFrame = 0;
  drawPixelApe(apeEl, 0);
}

const apeEl = document.getElementById('pixelApe');
drawPixelApe(apeEl);

// Ape behavior - hangs small by logo, grows big when exploring
function getApeHome() { return window.innerWidth <= 640 ? 65 : 90; }
function getApeZone() { return window.innerWidth <= 640 ? 100 : 160; }
// Keep backward-compat references (evaluated dynamically)
let APE_HOME = getApeHome();
let APE_ZONE = getApeZone();
window.addEventListener('resize', () => { APE_HOME = getApeHome(); APE_ZONE = getApeZone(); });
let apeState = { x: APE_HOME, direction: 1, resting: true, restTimer: null, isBig: false, walkCancelled: false };

function updateApeSize() {
  const shouldBeBig = apeState.x > APE_ZONE;
  if (shouldBeBig !== apeState.isBig) {
    apeState.isBig = shouldBeBig;
    apeEl.classList.toggle('big', shouldBeBig);
  }
}

let apeWalkCount = 0;  // tracks walks since last home visit

function apeIdle() {
  clearTimeout(apeState.restTimer);
  apeEl.classList.remove('walking');
  stopApeArmSwing();

  const hasFriendsNow = headerCreatures.length > 0;
  const wait = hasFriendsNow ? (2000 + Math.random() * 4000) : (3000 + Math.random() * 7000);
  apeState.restTimer = setTimeout(() => {
    // Check LIVE — friends may have appeared since apeIdle was called
    const hasFriends = headerCreatures.length > 0;

    if (!hasFriends) {
      // No friends — original solo behavior with homing
      const isAwayFromHome = Math.abs(apeState.x - APE_HOME) > 30;
      if (apeWalkCount >= 1 && isAwayFromHome) {
        apeWalkCount = 0;
        apeWalkHome();
        return;
      }
      const action = Math.random();
      if (action < 0.28) {
        apeWalk();
      } else if (action < 0.50) {
        apeWalkHome();
      } else if (action < 0.65) {
        apeJump();
      } else if (action < 0.78) {
        apeSwing();
      } else {
        apeIdle();
      }
    } else {
      // Friends are out — stay in the mix, wander more
      const action = Math.random();
      if (action < 0.55) {
        apeWalk();             // Wander among friends
      } else if (action < 0.70) {
        apeJump();
      } else if (action < 0.82) {
        apeSwing();
      } else {
        apeIdle();             // Brief chill
      }
    }
  }, wait);
}

// Check if the ape's next position hits a creature
function apeHitsCreature(nextX) {
  const apeW = apeState.isBig ? 48 : 24;
  for (const c of headerCreatures) {
    const cw = getCreatureW(c);
    if (nextX < c.x + cw && nextX + apeW > c.x) return c;
  }
  return null;
}

function apeWalk() {
  apeWalkCount++;
  apeState.walkCancelled = false;
  const headerW = document.querySelector('header').offsetWidth;
  const hasFriends = headerCreatures.length > 0;
  // When friends are out, stay in the "big" zone (past APE_ZONE)
  const minX = hasFriends ? (APE_ZONE + 20) : 120;
  const target = minX + Math.random() * (headerW - minX - 50);
  const dx = target > apeState.x ? 1 : -1;
  apeEl.classList.toggle('flip', dx < 0);
  apeEl.classList.add('walking');
  startApeArmSwing();

  const step = () => {
    if (apeState.walkCancelled) {
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      return;
    }
    const headerWNow = document.querySelector('header').offsetWidth;
    const nextX = Math.max(0, Math.min(apeState.x + dx * 1.5, headerWNow - 50));
    const hitCreature = apeHitsCreature(nextX);
    if (hitCreature) {
      // Both stop and hang out, then go opposite ways
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      // Tell the creature to stop too and then walk away
      if (hitCreature.state === 'walking' || hitCreature.state === 'idle') {
        clearTimeout(hitCreature.timer);
        hitCreature.el.classList.remove('walking');
        hitCreature.state = 'hangout';
        const creatureDir = hitCreature.x < apeState.x ? -1 : 1;
        hitCreature.timer = setTimeout(() => {
          const hW = document.querySelector('header').offsetWidth;
          const ct = Math.max(120, Math.min(hitCreature.x + creatureDir * 50, hW - 50));
          creatureWalkTo(hitCreature, ct, () => creatureIdle(hitCreature));
        }, 1500 + Math.random() * 1500);
      }
      // Ape hangs out then goes the other way
      apeState.restTimer = setTimeout(() => apeIdle(), 1500 + Math.random() * 1500);
      return;
    }

    apeState.x = nextX;
    apeEl.style.left = apeState.x + 'px';
    updateApeSize();

    if ((dx > 0 && apeState.x < target) || (dx < 0 && apeState.x > target)) {
      requestAnimationFrame(() => setTimeout(step, 30));
    } else {
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      apeIdle();
    }
  };
  step();
}

function apeWalkHome() {
  // Never go home when friends are out — go wander instead
  if (headerCreatures.length > 0) { apeWalk(); return; }
  if (Math.abs(apeState.x - APE_HOME) < 20) { apeIdle(); return; }
  apeWalkCount = 0;
  apeState.walkCancelled = false;
  const dx = APE_HOME > apeState.x ? 1 : -1;
  apeEl.classList.toggle('flip', dx < 0);
  apeEl.classList.add('walking');
  startApeArmSwing();

  const step = () => {
    // Abort walk home if friends appeared or walk was cancelled
    if (apeState.walkCancelled || headerCreatures.length > 0) {
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      if (headerCreatures.length > 0) apeIdle();
      return;
    }
    const hWHome = document.querySelector('header').offsetWidth;
    const nextX = Math.max(0, Math.min(apeState.x + dx * 1.5, hWHome - 50));

    apeState.x = nextX;
    apeEl.style.left = apeState.x + 'px';
    updateApeSize();

    if ((dx > 0 && apeState.x < APE_HOME) || (dx < 0 && apeState.x > APE_HOME)) {
      requestAnimationFrame(() => setTimeout(step, 30));
    } else {
      apeState.x = APE_HOME;
      apeEl.style.left = APE_HOME + 'px';
      updateApeSize();
      apeEl.classList.remove('flip', 'walking');
      stopApeArmSwing();
      apeIdle();
    }
  };
  step();
}

let apeAnimTimer = null;

function apeJump() {
  apeEl.classList.remove('jump');
  void apeEl.offsetWidth;
  apeEl.classList.add('jump');
  clearTimeout(apeAnimTimer);
  apeAnimTimer = setTimeout(() => {
    apeEl.classList.remove('jump');
    apeIdle();
  }, 550);
}

function apeSwing() {
  apeEl.classList.remove('swing');
  void apeEl.offsetWidth;
  apeEl.classList.add('swing');
  clearTimeout(apeAnimTimer);
  apeAnimTimer = setTimeout(() => {
    apeEl.classList.remove('swing');
    apeIdle();
  }, 1600);
}

// Start ape behavior after a short delay
setTimeout(apeIdle, 3000);

// ─── PIXEL CREATURE FRIENDS ───
// 25 tiny 8-bit friends that appear in the header when you complete tasks

const CREATURE_DEFS = [
  { name:'lion', friend:'Addy the Lion', // 11 rows → oy=5
    pal:{ b:['#D4851F','#f5d6a0'], m:['#8B4513','#c8a070'], d:['#5C2D0A','#b8a080'] },
    ox:4, oy:5, rows:[
      '..mmmm..','.mmmmmm.','mmbbbbmm','mbdbdbmm','mbbdbmm.','.mbbm...',
      '..bbbb..','..bbbb..','.bbbbbb.','..bbbb..','..dd.dd.',
    ]},
  { name:'tiger', friend:'Tina the Tiger', // 9 rows → oy=7
    pal:{ b:['#E86820','#f5c8a0'], s:['#2a2a2a','#a08870'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:7, rows:[
      'sb....bs','.bb..bb.','.bbbbbb.','.bdbdbb.','.bbdbbb.','..sbbs..',
      '..bbbb..','..sbbs..','..dd.dd.',
    ]},
  { name:'bear', friend:'Bruno the Bear', // 9 rows → oy=7
    pal:{ b:['#8B4513','#d4b896'], a:['#D2A068','#f5e6d0'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:7, rows:[
      '.b....b.','.bb..bb.','.bbbbbb.','.bdbdbb.','.baadbb.','..bbbb..',
      '..bbbb..','..bbbb..','..dd.dd.',
    ]},
  { name:'cat', friend:'Cleo the Cat', // 8 rows → oy=8
    pal:{ b:['#888888','#c0b8b0'], d:['#1a1a1a','#d0c8b0'], s:['#F8A0A0','#d0a0a0'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.bbbbbb.','.bdbdbb.','.bbbsbb.','..bbbb..',
      '..bbbb..','..b..b..',
    ]},
  { name:'dog', friend:'Benji the Dog', // 9 rows → oy=7
    pal:{ b:['#5C3A1E','#c8a070'], a:['#C4880E','#f0d8a0'], d:['#1a1a1a','#d0c8b0'], s:['#E8605E','#d08888'] },
    ox:4, oy:7, rows:[
      '..b..b..','.bb..bb.','bbbbbbbb','.bdbdab.','.bbsbbb.','..babb..',
      '..bbbb..','..babb..','..dd.dd.',
    ]},
  { name:'frog', friend:'Fletch the Frog', // 6 rows → oy=10
    pal:{ b:['#4CAF50','#a8d8a0'], a:['#81C784','#c8e8c0'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:10, rows:[
      '.db..bd.','bbbbbbbb','.bbbbbb.','.babbab.','..aaaa..','..b..b..',
    ]},
  { name:'owl', friend:'Quinn the Owl', // 8 rows → oy=8
    pal:{ b:['#8B6914','#d4c090'], a:['#D2A068','#f5e6d0'], d:['#1a1a1a','#d0c8b0'], w:['#FFF','#3a2a1a'], s:['#F0A030','#d4a060'] },
    ox:4, oy:8, rows:[
      '..b..b..','.bbbbbb.','bwdbdwbb','bbbbbbbb','..bsbb..','..abba..','..abba..','..dd.dd.',
    ]},
  { name:'penguin', friend:'Pip the Penguin', // 8 rows → oy=8
    pal:{ b:['#2a2a2a','#d0c8b0'], w:['#F5F0E6','#3a2a1a'], s:['#F0A030','#d4a060'], d:['#1a1a1a','#f5f0e6'] },
    ox:4, oy:8, rows:[
      '..bbbb..','.bbbbbb.','.bwbbwb.','.bbsbbb.','.bwwwwb.','.bwwwwb.','..bbbb..','..ss.ss.',
    ]},
  { name:'rabbit', friend:'Rosie the Rabbit', // 9 rows → oy=7
    pal:{ b:['#F5F0E6','#5a4a3a'], a:['#F8B0B0','#d08888'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:7, rows:[
      '..b..b..','..b..b..','..ba.ab.','.bbbbbb.','.bdbdbb.','..bbbb..','..bbbb..','...bb...','..dd.dd.',
    ]},
  { name:'fox', friend:'Felix the Fox', // 8 rows → oy=8
    pal:{ b:['#E86820','#f5c8a0'], w:['#F5F0E6','#5a4a3a'], d:['#1a1a1a','#d0c8b0'], a:['#C04810','#c8a070'] },
    ox:4, oy:8, rows:[
      'ab....ba','.bb..bb.','.bbbbbb.','.bdbdbb.','..bwbb..','..wwww..','..bbbb..','..dd.dd.',
    ]},
  { name:'turtle', friend:'Truman the Turtle', // 7 rows → oy=9
    pal:{ b:['#2a7d4f','#a0d0b0'], a:['#4aad6f','#c0e8d0'], s:['#81C784','#d8f0d8'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:9, rows:[
      '.....sd.','...ssss.','.aaaaas.','abbaabbaaaaaas.','.aaaaas.','..aaaa..','..ss.ss.',
    ]},
  { name:'hedgehog', friend:'Hank the Hedgehog', // 7 rows → oy=9
    pal:{ b:['#8B6914','#d4c090'], s:['#5C2D0A','#a08870'], a:['#D2A068','#f5e6d0'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:9, rows:[
      '.ssssss.','sbbbbbbs','sbdbdbbs','.baabb..','..aabb..','...bb...','..dd.dd.',
    ]},
  { name:'parrot', friend:'Polly the Parrot', // 8 rows → oy=8
    pal:{ b:['#4CAF50','#a8d8a0'], r:['#E52E0A','#f08868'], s:['#F0A030','#d4a060'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:8, rows:[
      '..rrr...','.rrrbb..','.rdbbb..','..sbbb..','..bbbb..','..bbbb..','...bbb..','..dd.dd.',
    ]},
  { name:'mouse', friend:'Midge the Mouse', // 7 rows → oy=9
    pal:{ b:['#AAAAAA','#a09890'], a:['#F8B0B0','#d08888'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:9, rows:[
      '.ab..ba.','.bb..bb.','..bbbb..','..bdbdb.','..bbab..','...bb...','..dd.dd.',
    ]},
  { name:'bee', friend:'Buzz the Bee', // 7 rows → oy=9
    pal:{ b:['#F9ED32','#d4c860'], s:['#2a2a2a','#a08870'], w:['#D8E8F8','#4a5868'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:9, rows:[
      '..ww.ww.','..w..w..','.sbbbs..','.bsssb..','.sbbbs..','..bbb...','...b....',
    ]},
  { name:'ladybug', friend:'Lulu the Ladybug', // 7 rows → oy=9
    pal:{ b:['#E52E0A','#f08868'], d:['#1a1a1a','#d0c8b0'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:9, rows:[
      '..dddd..','dbwbbwbd','dbbddbbd','dbdbdbbd','.dbbbbd.','..dddd..','..d..d..',
    ]},
  { name:'butterfly', friend:'Belle the Butterfly', // 6 rows → oy=10
    pal:{ b:['#9C27B0','#c888d0'], a:['#2456A4','#7098c8'], s:['#1a1a1a','#d0c8b0'], w:['#FFF','#3a2a1a'] },
    ox:3, oy:10, rows:[
      '.b...b..','bwb.bwb.','bab.bab.','bbb.bbb.','.bsssb..','..s.s...',
    ]},
  { name:'crab', friend:'Carl the Crab', // 7 rows → oy=9
    pal:{ b:['#E52E0A','#f08868'], s:['#F06030','#f0a888'], d:['#1a1a1a','#d0c8b0'], w:['#FFF','#3a2a1a'] },
    ox:3, oy:9, rows:[
      'd..bb..d','db.bb.bd','.bbbbbb.','.bwbbwb.','.bbbbbb.','..b..b..','.b....b.',
    ]},
  { name:'elephant', friend:'Ellie the Elephant', // 8 rows → oy=8
    pal:{ b:['#8899AA','#b0b8c0'], a:['#AAB8C8','#c8d0d8'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:8, rows:[
      'b......b','.bbbbbb.','bbbbbbbb','bdbdbbbb','bbbabbbb','.bba....','..bbbb..','..dd.dd.',
    ]},
  { name:'giraffe', friend:'Gus the Giraffe', // 9 rows → oy=7
    pal:{ b:['#E8B84E','#f0d8a0'], s:['#8B4513','#c8a070'], d:['#1a1a1a','#d0c8b0'], a:['#D2A068','#e8c898'] },
    ox:4, oy:7, rows:[
      '..a..a..','..bb....','..bb....','.bbbb...','.bsbsb..','.bbbbb..','..bsb...','..bbb...','..dd.dd.',
    ]},
  { name:'sloth', friend:'Sid the Sloth', // 9 rows → oy=7
    pal:{ b:['#8B6914','#d4c090'], a:['#D2A068','#f5e6d0'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:7, rows:[
      '..bbbb..','.bbbbbb.','.baaaab.','.badaab.','.badaab.','..bbbb..','..bbbb..','..bbbb..','..dd.dd.',
    ]},
  { name:'panda', friend:'Paddy the Panda', // 8 rows → oy=8
    pal:{ b:['#F5F0E6','#5a4a3a'], d:['#2a2a2a','#c0b8b0'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:8, rows:[
      '.d....d.','.dd..dd.','.dbbbbd.','ddbwbwdd','.dbbbbd.','..dbbd..','..bbbb..','..dd.dd.',
    ]},
  { name:'koala', friend:'Kid the Koala', // 8 rows → oy=8
    pal:{ b:['#8899AA','#b0b8c0'], a:['#F8B0B0','#d08888'], d:['#1a1a1a','#d0c8b0'], w:['#AAB8C8','#c8d0d8'] },
    ox:4, oy:8, rows:[
      'bab.bab.','bbb.bbb.','.bbbbbb.','.bdbdbb.','.bbwbbb.','..bbbb..','..bbbb..','..dd.dd.',
    ]},
  { name:'duck', friend:'Iggy the Duck', // 8 rows → oy=8
    pal:{ b:['#F9ED32','#d4c860'], s:['#F0A030','#d4a060'], d:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:8, rows:[
      '..bbbb..','.bbbbbb.','.bdbdbb.','..bssb..','..bbbb..','.bbbbbb.','..bbbb..','..ss.ss.',
    ]},
  { name:'snake', friend:'Sal the Snake', // 8 rows → oy=8
    pal:{ b:['#4CAF50','#a8d8a0'], a:['#81C784','#c8e8c0'], d:['#E52E0A','#f08868'], s:['#1a1a1a','#d0c8b0'] },
    ox:4, oy:8, rows:[
      '..sb....','.bbbb...','..ab....','...ab...','.bbbb...','.ba.....','..ab....','.bbd....',
    ]},
  // ─── SURPRISE GUESTS ───
  { name:'bowie', friend:'David Bowie', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5E0C0','#8a7060'], h:['#E86820','#c8a070'], z:['#2456A4','#7098c8'], d:['#1a1a1a','#d0c8b0'], r:['#E52E0A','#f08868'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:7, rows:[
      '..hhhh..','.hhhhhh.','hbzbwbhh','hbbbbhh.','.bbbbh..','..bbbb..','..bbbb..','..bbbb..','..dd.dd.',
    ]},
  { name:'taylor', friend:'Taylor Swift', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5E0C0','#8a7060'], h:['#F0D060','#c8a860'], d:['#1a1a1a','#d0c8b0'], r:['#E52E0A','#f08868'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbrbhh.','.hbbhh..','..bbbb..','..rrrr..','..bbbb..','..dd.dd.',
    ]},
  { name:'lennon', friend:'John Lennon', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5E0C0','#8a7060'], h:['#8B4513','#c8a070'], d:['#1a1a1a','#d0c8b0'], g:['#F0A030','#d4a060'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:7, rows:[
      'hh...hh.','hhhhhhh.','hbdbdbh.','hgwbwgh.','hbbbbhh.','.hbbh...','..bbbb..','..bbbb..','..dd.dd.',
    ]},
  { name:'harry', friend:'Harry Styles', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5E0C0','#8a7060'], h:['#5C2D0A','#b8a080'], d:['#1a1a1a','#d0c8b0'], r:['#E52E0A','#f08868'], p:['#9C27B0','#c888d0'], w:['#FFF','#3a2a1a'] },
    ox:4, oy:7, rows:[
      '.hhh.hh.','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..pppp..','..pbpp..','..bbbb..','..dd.dd.',
    ]},
  { name:'freddie', friend:'Freddie Mercury', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5DEB3','#8a7060'], h:['#2a2a2a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], m:['#5C2D0A','#b8a080'], w:['#FFF','#3a2a1a'], r:['#E52E0A','#f08868'], y:['#F9ED32','#d4c860'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbmmbhh.','.hbbh...','..yyyy..','..wbbw..','..bbbb..','..dd.dd.',
    ]},
  { name:'prince', friend:'Prince', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#d4b896'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], p:['#9C27B0','#c888d0'], w:['#FFF','#3a2a1a'], r:['#E52E0A','#f08868'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhh..','hbdbdbh.','hbbbbh..','.hbbh...','..pppp..','..pbbp..','..bbbb..','..dd.dd.',
    ]},
  { name:'hendrix', friend:'Jimi Hendrix', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], r:['#E52E0A','#f08868'], w:['#FFF','#3a2a1a'], a:['#D2A068','#f5e6d0'] },
    ox:4, oy:7, rows:[
      '.hh..hh.','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..rrrr..','..rbbr..','..bbbb..','..dd.dd.',
    ]},
  // ─── PET CATS ───
  { name:'fifi', friend:'Fifi the Cat', // 8 rows → oy=8
    pal:{ b:['#E8923A','#f0c090'], d:['#1a1a1a','#d0c8b0'], s:['#F8A0A0','#d0a0a0'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.bbbbbb.','.bdbdbb.','.bbbsbb.','..bbbb..','..bbbb..','..b..b..',
    ]},
  { name:'arlo', friend:'Arlo the Cat', // 8 rows → oy=8
    pal:{ b:['#E8923A','#f0c090'], w:['#F5F0E6','#5a4a3a'], d:['#1a1a1a','#d0c8b0'], s:['#F8A0A0','#d0a0a0'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.wwwwww.','.wdwdwb.','.wbwsbb.','..bbbb..','..bbbb..','..b..b..',
    ]},
  { name:'oona', friend:'Oona the Cat', // 8 rows → oy=8
    pal:{ b:['#D4801F','#e8b870'], d:['#1a1a1a','#d0c8b0'], s:['#F8A0A0','#d0a0a0'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.bbbbbb.','.bdbdbb.','.bbbsbb.','..bbbb..','..bbbb..','..b..b..',
    ]},
  { name:'jingle', friend:'Jingle the Cat', // 8 rows → oy=8
    pal:{ b:['#E8923A','#f0c090'], d:['#1a1a1a','#d0c8b0'], s:['#F8A0A0','#d0a0a0'] },
    ox:3, oy:8, rows:[
      'b........b','.b......b.','.bbbbbbbb.','.bbdbdbbb.','.bbbbbsbb.','..bbbbbb..','..bbbbbb..','...b..b...',
    ]},
  { name:'rainbow', friend:'Rainbow the Cat', // 8 rows → oy=8
    pal:{ b:['#1a1a1a','#d0c8b0'], d:['#4a4a4a','#a0a0a0'], s:['#F8A0A0','#d0a0a0'], w:['#F9ED32','#d4c860'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.bbbbbb.','.bwbwbb.','.bbbsbb.','..bbbb..','..bbbb..','..b..b..',
    ]},
  { name:'chloe', friend:'Chloe the Cat', // 8 rows → oy=8
    pal:{ b:['#2a2a2a','#c0b8b0'], d:['#4a4a4a','#a0a0a0'], s:['#F8A0A0','#d0a0a0'], w:['#4CAF50','#a8d8a0'] },
    ox:4, oy:8, rows:[
      'b......b','.b....b.','.bbbbbb.','.bwbwbb.','.bbbsbb.','..bbbb..','..bbbb..','..b..b..',
    ]},
  { name:'archie', friend:'Archie the Aardvark', // 9 rows → oy=7
    pal:{ b:['#B8977A','#d4c0a8'], d:['#1a1a1a','#d0c8b0'], a:['#D2A068','#f5e6d0'] },
    ox:4, oy:7, rows:[
      '..bbbb..','..bbbb..','.bdbdbb.','.bbbbbb.','.bbbbbb.','..bbbb..','..babb..','..bbbb..','..dd.dd.',
    ]},
  { name:'luke', friend:'Luke the Loon', // 9 rows → oy=7
    pal:{ b:['#1a1a1a','#d0c8b0'], w:['#F5F0E6','#3a2a1a'], d:['#E52E0A','#f08868'], s:['#2a2a2a','#c0b8b0'] },
    ox:4, oy:7, rows:[
      '..bbbb..','.bbbbbb.','.bwbbwb.','.bbdbbb.','.bwwwwb.','.bbbbbb.','..bbbb..','..bbbb..','..ss.ss.',
    ]},
  { name:'levitt', friend:'Levitt the Lobster', // 8 rows → oy=8
    pal:{ b:['#C0392B','#e08070'], d:['#1a1a1a','#d0c8b0'], w:['#FFF','#3a2a1a'], s:['#E74C3C','#f0a098'] },
    ox:3, oy:8, rows:[
      'd..bb..d','db.bb.bd','.sbbbbs.','.bwbbwb.','.bbbbbb.','.sbbbbs.','..b..b..','.b....b.',
    ]},
  { name:'natnael', friend:'Natnael the Narwhal', // 9 rows → oy=7
    pal:{ b:['#7BA4C8','#a0c0d8'], w:['#F5F0E6','#3a2a1a'], d:['#1a1a1a','#d0c8b0'], h:['#D4A84B','#e8c870'] },
    ox:4, oy:7, rows:[
      '....h...','..bbbb..','.bbbbbb.','bbwbbwbb','bbbbbbbb','.bbbbbb.','..bbbb..','...bb...','...dd...',
    ]},
  // ─── SURPRISE NFL GUESTS ───
  { name:'marino', friend:'Dan Marino', surprise:true, // 9 rows → oy=7
    pal:{ b:['#F5E0C0','#8a7060'], h:['#5C2D0A','#b8a080'], d:['#1a1a1a','#d0c8b0'], t:['#008E97','#60b8c0'], w:['#F06030','#f0a888'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..tbbw..','..bbbb..','..dd.dd.',
    ]},
  { name:'payton', friend:'Walter Payton', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#0B162A','#6080a0'], w:['#E86820','#f0a868'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbw..','..bbbb..','..dd.dd.',
    ]},
  { name:'rice', friend:'Jerry Rice', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#AA0000','#c86060'], w:['#D4A84B','#e8c870'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbt..','..bbbb..','..dd.dd.',
    ]},
  { name:'moss', friend:'Randy Moss', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#4F2683','#9070b0'], w:['#F9ED32','#d4c860'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbt..','..bbbb..','..dd.dd.',
    ]},
  // ─── SURPRISE NBA GUESTS ───
  { name:'jordan', friend:'Michael Jordan', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#CE1141','#d87088'], w:['#F5F0E6','#3a2a1a'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbt..','..bbbb..','..dd.dd.',
    ]},
  { name:'kobe', friend:'Kobe Bryant', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#552583','#9070b0'], w:['#FDB927','#e8c870'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbt..','..bbbb..','..dd.dd.',
    ]},
  { name:'garnett', friend:'Kevin Garnett', surprise:true, // 9 rows → oy=7
    pal:{ b:['#A0622E','#c8a070'], h:['#1a1a1a','#d0c8b0'], d:['#1a1a1a','#d0c8b0'], t:['#0C2340','#506888'], w:['#236192','#70a0c0'] },
    ox:4, oy:7, rows:[
      '..hhhh..','hhhhhhh.','hbdbdbh.','hbbbbhh.','.hbbh...','..tttt..','..twbt..','..bbbb..','..dd.dd.',
    ]},
];

function renderSprite(canvas, def, isDark) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 16, 16);
  const ci = isDark ? 1 : 0;
  const ox = def.ox || 0, oy = def.oy || 0;
  def.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch !== '.' && def.pal[ch]) {
        ctx.fillStyle = def.pal[ch][ci];
        ctx.fillRect(x + ox, y + oy, 1, 1);
      }
    }
  });
}

// ─── Creature state ───
let headerCreatures = [];
let creatureSpawnDate = new Date().toDateString();
let creaturePool = [];

function getCreatureW(c) { return c.isBig ? 40 : 20; }

function updateCreatureSize(c) {
  const shouldBeBig = c.x > APE_ZONE;
  if (shouldBeBig !== c.isBig) {
    c.isBig = shouldBeBig;
    c.el.classList.toggle('big', shouldBeBig);
  }
}

function shuffleCreaturePool() {
  creaturePool = Array.from({length: CREATURE_DEFS.length}, (_, i) => i);
  for (let i = creaturePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [creaturePool[i], creaturePool[j]] = [creaturePool[j], creaturePool[i]];
  }
}
shuffleCreaturePool();

function clearAllCreatures() {
  if (typeof hideCharTooltip === 'function') hideCharTooltip();
  headerCreatures.forEach(c => { clearTimeout(c.timer); c.el.remove(); });
  headerCreatures = [];
}

function isCreatureDark() {
  return document.body.getAttribute('data-theme') === 'dark';
}

// Find an open x position in the header near the ape and friends
function findOpenSpot() {
  const headerW = document.querySelector('header').offsetWidth;
  const minX = APE_ZONE + 20;
  const maxX = headerW - 50;
  const taken = headerCreatures.map(c => c.x);
  taken.push(apeState.x);

  // Search outward from the ape's position so creatures join the group
  const center = Math.max(minX, Math.min(apeState.x, maxX));
  for (let dist = 0; dist < maxX - minX; dist += 32) {
    // Try right of center, then left
    const candidates = [center + dist];
    if (dist > 0) candidates.push(center - dist);
    for (const x of candidates) {
      if (x < minX || x > maxX) continue;
      let ok = true;
      for (const t of taken) {
        if (Math.abs(x - t) < 44) { ok = false; break; }
      }
      if (ok) return x;
    }
  }
  return minX + Math.random() * (maxX - minX);
}

// Check if a creature's next position overlaps anything
function creatureBlocked(creature, nextX) {
  const w = getCreatureW(creature);
  for (const c of headerCreatures) {
    if (c === creature) continue;
    const cw = getCreatureW(c);
    if (nextX < c.x + cw && nextX + w > c.x) return true;
  }
  const apeW = apeState.isBig ? 48 : 24;
  if (nextX < apeState.x + apeW && nextX + w > apeState.x) return true;
  return false;
}

// ─── Creature behaviors ───
function creatureIdle(c) {
  clearTimeout(c.timer);
  c.el.classList.remove('walking');
  c.state = 'idle';

  const wait = 2000 + Math.random() * 5000;
  c.timer = setTimeout(() => {
    const action = Math.random();
    if (action < 0.6) {
      // Wander to a random spot across the full header
      const headerW = document.querySelector('header').offsetWidth;
      const target = 120 + Math.random() * (headerW - 170);
      creatureWalkTo(c, target, () => creatureIdle(c));
    } else {
      creatureIdle(c); // chill
    }
  }, wait);
}

function creatureWalkTo(c, target, onDone) {
  const dx = target > c.x ? 1 : -1;
  c.direction = dx;
  c.el.classList.toggle('flip', dx < 0);
  c.el.classList.add('walking');
  c.state = 'walking';

  const step = () => {
    const headerWNow = document.querySelector('header').offsetWidth;
    const cw = getCreatureW(c);
    const maxX = headerWNow - cw - 10;
    const nextX = Math.max(0, Math.min(c.x + dx * 1, maxX));
    // If we hit the edge AND are moving away from target, stop
    if ((nextX <= 0 && dx < 0) || (nextX >= maxX && dx > 0)) {
      c.el.classList.remove('walking');
      c.state = 'idle';
      creatureIdle(c);
      return;
    }
    if (creatureBlocked(c, nextX)) {
      // Stop and hang out for a bit, then move on
      c.el.classList.remove('walking');
      c.state = 'hangout';
      c.timer = setTimeout(() => {
        creatureIdle(c);
      }, 2000 + Math.random() * 2000);
      return;
    }
    c.x = nextX;
    c.el.style.left = c.x + 'px';
    updateCreatureSize(c);
    if ((dx > 0 && c.x < target) || (dx < 0 && c.x > target)) {
      requestAnimationFrame(() => setTimeout(step, 45));
    } else {
      c.el.classList.remove('walking');
      if (onDone) onDone();
    }
  };
  step();
}

// ─── Ape greeting ───
function apeGreetAtSpot(creature, spotX) {
  apeState.walkCancelled = false;
  clearTimeout(apeState.restTimer);
  clearTimeout(apeAnimTimer);
  apeEl.classList.remove('walking', 'jump', 'swing');
  stopApeArmSwing();

  // Walk to the creature — approach from whichever side the ape is on
  const gap = 50;
  const target = apeState.x < spotX ? (spotX - gap) : (spotX + gap);
  const dx = target > apeState.x ? 1 : -1;
  apeEl.classList.toggle('flip', dx < 0);
  apeEl.classList.add('walking');
  startApeArmSwing();

  const step = () => {
    if (apeState.walkCancelled) {
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      return;
    }
    const nextX = apeState.x + dx * 1.5;

    // If we hit another creature on the way, pause briefly then keep going
    const hit = apeHitsCreature(nextX);
    if (hit && hit !== creature) {
      // Nudge the blocking creature out of the way gently
      if (hit.state === 'idle' || hit.state === 'hangout') {
        clearTimeout(hit.timer);
        hit.el.classList.remove('walking');
        const nudgeDir = hit.x < apeState.x ? -1 : 1;
        const hW = document.querySelector('header').offsetWidth;
        const ct = Math.max(120, Math.min(hit.x + nudgeDir * 40, hW - 50));
        creatureWalkTo(hit, ct, () => creatureIdle(hit));
      }
      // Ape pauses a beat then continues toward the new friend
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      apeState.restTimer = setTimeout(() => apeGreetAtSpot(creature, spotX), 800);
      return;
    }

    const hWNow = document.querySelector('header').offsetWidth;
    apeState.x = Math.max(0, Math.min(nextX, hWNow - 50));
    apeEl.style.left = apeState.x + 'px';
    updateApeSize();
    if ((dx > 0 && apeState.x < target) || (dx < 0 && apeState.x > target)) {
      requestAnimationFrame(() => setTimeout(step, 30));
    } else {
      apeEl.classList.remove('walking');
      stopApeArmSwing();
      // Happy jump!
      apeJump();
    }
  };
  step();
}

// ─── Unlock banner ───
let unlockTimer = null;
function showUnlockBanner(def) {
  const banner = document.getElementById('unlockBanner');
  const text = document.getElementById('unlockText');
  if (def.surprise) {
    text.innerHTML = 'SURPRISE! You\'ve unlocked <strong>' + def.friend + '</strong>!';
  } else {
    text.textContent = 'Nice job! You\'ve unlocked ' + def.friend + '!';
  }
  clearTimeout(unlockTimer);
  banner.classList.remove('show');
  void banner.offsetWidth;
  banner.classList.add('show');
  unlockTimer = setTimeout(() => banner.classList.remove('show'), 3500);
}

// ─── Character tooltips ───
const tooltipEl = document.getElementById('creatureTooltip');
let tooltipTarget = null;

function showCharTooltip(el, name, isSurprise) {
  tooltipTarget = el;
  if (isSurprise) {
    tooltipEl.textContent = '\u26A1 ' + name;
  } else {
    tooltipEl.textContent = name;
  }
  positionTooltip();
  tooltipEl.classList.add('show');
}

function hideCharTooltip() {
  tooltipTarget = null;
  tooltipEl.classList.remove('show');
}

function positionTooltip() {
  if (!tooltipTarget) return;
  const rect = tooltipTarget.getBoundingClientRect();
  const tipH = tooltipEl.offsetHeight;
  const tipW = tooltipEl.offsetWidth;
  let left = rect.left + rect.width / 2 - tipW / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tipW - 4));
  // Show below if too close to top of screen
  const above = rect.top - tipH - 6;
  const top = above < 4 ? (rect.bottom + 6) : above;
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

// TinyApe tooltip
apeEl.addEventListener('mouseenter', () => showCharTooltip(apeEl, 'TinyApe'));
apeEl.addEventListener('mouseleave', hideCharTooltip);

// Keep tooltip positioned while characters move
setInterval(() => { if (tooltipTarget) positionTooltip(); }, 50);

// ─── Spawn on task completion ───
function spawnCreature() {
  // Daily reset
  const today = new Date().toDateString();
  if (today !== creatureSpawnDate) {
    clearAllCreatures();
    creatureSpawnDate = today;
    shuffleCreaturePool();
  }

  const isFirstFriend = headerCreatures.length === 0;

  if (creaturePool.length === 0) shuffleCreaturePool();
  const defIndex = creaturePool.pop();
  const def = CREATURE_DEFS[defIndex];
  showUnlockBanner(def);

  // Persist to Supabase for cross-device restoration
  if (window.TinyApeDB && window.TinyApeDB.saveCreatureUnlock) {
    window.TinyApeDB.saveCreatureUnlock(defIndex).catch(err =>
      console.error('Error saving creature unlock:', err));
  }

  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  canvas.className = 'pixel-creature';
  const header = document.querySelector('header');
  // Start just inside the right edge (header has overflow:hidden)
  const startX = header.offsetWidth - 25;
  canvas.style.left = startX + 'px';
  header.appendChild(canvas);
  renderSprite(canvas, def, isCreatureDark());

  // Tooltip on hover
  canvas.addEventListener('mouseenter', () => showCharTooltip(canvas, def.friend, def.surprise));
  canvas.addEventListener('mouseleave', hideCharTooltip);

  const creature = { el: canvas, defIndex, x: startX, state: 'entering', direction: -1, timer: null, isBig: false };
  headerCreatures.push(creature);
  updateCreatureSize(creature);

  // Walk in from right to an open spot
  const spot = findOpenSpot();
  creatureWalkTo(creature, spot, () => {
    creatureIdle(creature);
  });

  // TinyApe heads out to greet immediately — cancel EVERYTHING and go
  apeState.walkCancelled = true;
  clearTimeout(apeState.restTimer);
  clearTimeout(apeAnimTimer);
  apeEl.classList.remove('walking', 'jump', 'swing');
  stopApeArmSwing();
  // Small delay so the creature is visible entering before ape reacts
  setTimeout(() => apeGreetAtSpot(creature, spot), 300);
}

// ─── Restore today's creatures from Supabase on page load ───
function restoreCreaturesFromUnlocks(unlocks) {
  if (!unlocks || unlocks.length === 0) return;

  // Filter to today's unlocks only
  const todayStr = new Date().toDateString();
  const todayUnlocks = unlocks.filter(u => {
    const d = new Date(u.unlockedAt);
    return d.toDateString() === todayStr;
  });

  if (todayUnlocks.length === 0) return;

  // Remove restored indices from the creature pool so they don't repeat
  const restoredIndices = todayUnlocks.map(u => u.creatureIndex);
  creaturePool = creaturePool.filter(i => !restoredIndices.includes(i));

  const header = document.querySelector('header');
  if (!header) return;

  // Filter out creatures already displayed in the header
  const displayedIndices = headerCreatures.map(c => c.defIndex);

  todayUnlocks.forEach((unlock, i) => {
    const defIndex = unlock.creatureIndex;
    if (displayedIndices.includes(defIndex)) return;  // already on screen
    const def = CREATURE_DEFS[defIndex];
    if (!def) return;

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.className = 'pixel-creature';

    // Place directly at a spot (no walk-in animation)
    const spot = findOpenSpot();
    canvas.style.left = spot + 'px';
    header.appendChild(canvas);
    renderSprite(canvas, def, isCreatureDark());

    canvas.addEventListener('mouseenter', () => showCharTooltip(canvas, def.friend, def.surprise));
    canvas.addEventListener('mouseleave', hideCharTooltip);

    const creature = { el: canvas, defIndex, x: spot, state: 'idle', direction: 1, timer: null, isBig: false };
    headerCreatures.push(creature);
    updateCreatureSize(creature);
    creatureIdle(creature);
  });
}

// ─── Collision monitor — creatures gently move aside ───
setInterval(() => {
  const apeW = apeState.isBig ? 48 : 24;
  headerCreatures.forEach(c => {
    if (c.state !== 'idle') return;
    const cw = getCreatureW(c);
    // Check ape overlap
    if (c.x < apeState.x + apeW + 4 && c.x + cw > apeState.x - 4) {
      const dir = c.x < apeState.x ? -1 : 1;
      const headerW = document.querySelector('header').offsetWidth;
      const target = Math.max(120, Math.min(c.x + dir * 35, headerW - 50));
      creatureWalkTo(c, target, () => creatureIdle(c));
    }
    // Check creature-creature overlap (gentle nudge)
    for (const other of headerCreatures) {
      if (other === c || other.state !== 'idle') continue;
      const ow = getCreatureW(other);
      if (c.x < other.x + ow + 2 && c.x + cw > other.x - 2) {
        const dir = c.x < other.x ? -1 : 1;
        const headerW = document.querySelector('header').offsetWidth;
        const target = Math.max(120, Math.min(c.x + dir * 25, headerW - 50));
        creatureWalkTo(c, target, () => creatureIdle(c));
        break;
      }
    }
  });
}, 400);

// ─── HALL OF FAME ───
// Simulated historical completions (will come from DB later)
// Each bump of the counter is a "completion event" — tasks, checklist items, time sessions
const completionLog = [];

// Log a completion event (called alongside bumpCounter)
function logCompletion() {
  completionLog.push({ ts: new Date().toISOString() });
  renderHallOfFame();
}

function getMonday(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = start of week
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0,0,0,0);
  return dt;
}

function computeHofData() {
  const now = new Date();
  const todayStr = _localDateStr(now);
  const thisMonday = getMonday(now);
  const thisSunday = new Date(thisMonday);
  thisSunday.setDate(thisSunday.getDate() + 6);

  // Count by day (local timezone)
  const dayCounts = {};
  completionLog.forEach(e => {
    if (!e.ts) return;
    const day = _tsToLocalDate(e.ts);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  });

  // Build sorted day list
  const days = Object.entries(dayCounts)
    .map(([date, count]) => ({ date, count, isToday: date === todayStr }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Count by week (Mon–Sun, local timezone)
  const weekCounts = {};
  completionLog.forEach(e => {
    if (!e.ts) return;
    const d = new Date(e.ts);
    const mon = getMonday(d);
    const key = _localDateStr(mon);
    weekCounts[key] = (weekCounts[key] || 0) + 1;
  });

  const thisMondayStr = _localDateStr(thisMonday);
  const weeks = Object.entries(weekCounts)
    .map(([monStr, count]) => {
      const mon = new Date(monStr + 'T00:00:00');
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      return { start: monStr, end: _localDateStr(sun), count, isThisWeek: monStr === thisMondayStr };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { days, weeks };
}

// Hall of Fame mobile modal — triggered by logo click on mobile
document.querySelector('.logo').addEventListener('click', () => {
  if (window.innerWidth > 640) return; // Desktop has the sidebar
  if (completionLog.length === 0) return; // No data yet
  openHofModal();
});

function openHofModal() {
  const content = document.getElementById('hofModalContent');
  // Reuse the same HTML as the sidebar
  const el = document.getElementById('hallOfFame');
  content.innerHTML = el.innerHTML;
  document.getElementById('hofModalOverlay').classList.add('open');
  document.getElementById('hofModal').classList.add('open');
}

function closeHofModal() {
  document.getElementById('hofModalOverlay').classList.remove('open');
  document.getElementById('hofModal').classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHofModal();
});

function renderHallOfFame() {
  const el = document.getElementById('hallOfFame');
  const { days, weeks } = computeHofData();

  // Show if there's any data at all
  const hasAnyData = completionLog.length > 0;
  if (!hasAnyData) {
    el.classList.remove('visible');
    return;
  }

  const rankNum = (i) => i === 0 ? '★' : (i + 1) + '.';
  const rankClass = (i) => {
    if (i === 0) return 'hof-entry-gold';
    return '';
  };

  let html = '';

  // Best Days plaque
  html += `<div class="hof-section"><div class="hof-plaque">
    <div class="hof-header">⚡ Best Days</div>`;
  for (let i = 0; i < 5; i++) {
    const d = days[i];
    if (d) {
      const dt = new Date(d.date + 'T00:00:00');
      const liveClass = d.isToday ? ' hof-entry-live' : '';
      const label = d.isToday ? 'TODAY' : fmtDate(dt);
      html += `<div class="hof-entry ${rankClass(i)}${liveClass}">
        <span class="hof-rank">${rankNum(i)}</span>
        <span>
          <span class="hof-count">${d.count} tasks</span><br>
          <span class="hof-date">${label}</span>
        </span>
      </div>`;
    } else {
      html += `<div class="hof-entry hof-entry-empty">
        <span class="hof-rank">${rankNum(i)}</span>
        <span><span class="hof-count">—</span></span>
      </div>`;
    }
  }
  html += `</div></div>`;

  // Best Weeks plaque
  html += `<div class="hof-section"><div class="hof-plaque">
    <div class="hof-header">⚡ Best Weeks</div>`;
  for (let i = 0; i < 5; i++) {
    const w = weeks[i];
    if (w) {
      const s = new Date(w.start + 'T00:00:00');
      const e = new Date(w.end + 'T00:00:00');
      const liveClass = w.isThisWeek ? ' hof-entry-live' : '';
      const label = w.isThisWeek ? `THIS WEEK` : `${fmtDate(s)}–${fmtDate(e)}`;
      html += `<div class="hof-entry ${rankClass(i)}${liveClass}">
        <span class="hof-rank">${rankNum(i)}</span>
        <span>
          <span class="hof-count">${w.count} tasks</span><br>
          <span class="hof-date">${label}</span>
        </span>
      </div>`;
    } else {
      html += `<div class="hof-entry hof-entry-empty">
        <span class="hof-rank">${rankNum(i)}</span>
        <span><span class="hof-count">—</span></span>
      </div>`;
    }
  }
  html += `</div></div>`;

  el.innerHTML = html;
  el.classList.add('visible');
}

// ─── DUE TODAY POPUP ───
// Shows once per day on first load if there are On Deck items due today.

function checkDueTodayPopup() {
  const todayStr = _localDateStr();

  // Only show once per day
  try {
    if (localStorage.getItem('tinyape-due-today-shown') === todayStr) return;
  } catch(e) {}

  // Find On Deck items due today (not already in Today, not done, not in drawer)
  const dueTodayTasks = store.tasks.filter(t =>
    t.dueDate === todayStr && !t.today && !t.done && !t.drawer
  );

  if (!dueTodayTasks.length) return;

  // Mark as shown
  try { localStorage.setItem('tinyape-due-today-shown', todayStr); } catch(e) {}

  showDueTodayPopup(dueTodayTasks);
}

function showDueTodayPopup(tasks) {
  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'due-today-overlay';
  overlay.onclick = () => closeDueTodayPopup();

  // Popup
  const popup = document.createElement('div');
  popup.className = 'due-today-popup';
  popup.id = 'dueTodayPopup';

  let itemsHtml = tasks.map(t => {
    const notesIcon = t.notes ? '<span class="notes-indicator">📄</span>' : '';
    const projectIcon = t.isProject ? '<span class="project-indicator">⏱</span>' : '';
    return `<div class="due-today-item" data-id="${t.id}">
      <button class="vote-btn" onclick="dueTodayVoteUp(${qid(t.id)})" title="Add to today">
        ${plusSvg}
      </button>
      <span class="due-today-title">${t.title}${notesIcon}${projectIcon}</span>
    </div>`;
  }).join('');

  popup.innerHTML = `
    <div class="due-today-handle"></div>
    <div class="due-today-header">
      <span class="due-today-heading">Due today</span>
      <span class="due-today-count">${tasks.length}</span>
    </div>
    <div class="due-today-list">${itemsHtml}</div>
    <div class="due-today-footer">
      <button class="due-today-vote-all" onclick="dueTodayVoteAll()">Vote all up</button>
      <button class="due-today-dismiss" onclick="closeDueTodayPopup()">Dismiss</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}

function dueTodayVoteUp(id) {
  const row = document.querySelector(`.due-today-item[data-id="${id}"]`);
  if (row) {
    row.style.opacity = '0.4';
    row.querySelector('.vote-btn').disabled = true;
    row.querySelector('.vote-btn').innerHTML = '<span style="color:var(--accent-red);font-size:12px;">✓</span>';
  }
  api.voteUp(id);
  render();

  // If all items voted, auto-close after a beat
  const remaining = document.querySelectorAll('.due-today-item:not([style*="opacity"])');
  if (!remaining.length) {
    setTimeout(() => closeDueTodayPopup(), 400);
  }
}

function dueTodayVoteAll() {
  const items = document.querySelectorAll('.due-today-item');
  items.forEach(row => {
    const id = row.dataset.id;
    const task = store.tasks.find(t => t.id === id);
    if (task && !task.today && !task.done) {
      api.voteUp(id);
      row.style.opacity = '0.4';
      const btn = row.querySelector('.vote-btn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span style="color:var(--accent-red);font-size:12px;">✓</span>';
      }
    }
  });
  render();
  setTimeout(() => closeDueTodayPopup(), 500);
}

function closeDueTodayPopup() {
  const overlay = document.querySelector('.due-today-overlay');
  const popup = document.getElementById('dueTodayPopup');
  if (overlay) overlay.remove();
  if (popup) popup.remove();
}

// ─── INIT ───
// Initialization is handled by boot() in index.html
// which loads data from Supabase before calling setDate(), render(), renderHallOfFame()
