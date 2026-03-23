// TinyApe Sync Layer
// Wraps in-memory API mutations with Supabase persistence
// Operates "local-first" — the in-memory store is always fast,
// and DB writes happen async in the background.

(function() {
  'use strict';

  // Wait for app.js to define `api` and `store`, then patch mutations
  function patchApiForSync() {
    if (typeof api === 'undefined' || typeof store === 'undefined') {
      setTimeout(patchApiForSync, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) {
      console.warn('TinyApeDB not available — running in offline mode');
      return;
    }

    // Helper: persist a task to Supabase (fire-and-forget)
    function persistTask(task) {
      if (!task) return;
      DB.saveTask(task).catch(err => console.error('Sync error (saveTask):', err));
    }

    // Helper: persist all today tasks (for reorder)
    function persistTodayOrder() {
      const todayTasks = store.tasks.filter(t => t.today && !t.done);
      todayTasks.forEach(t => persistTask(t));
    }

    // ─── Patch addTask ───
    const _origAddTask = api.addTask.bind(api);
    api.addTask = function(title, category, recurring, recurDays, dueDate, drawer) {
      const task = _origAddTask(title, category, recurring, recurDays, dueDate, drawer);
      // Save to DB — the DB will assign a UUID, but we keep the local integer ID
      // for this session. On next reload, IDs come from DB.
      DB.saveTask(task).then(saved => {
        if (saved && saved.id !== task.id) {
          // Replace local integer ID with DB UUID
          const oldId = task.id;
          task.id = saved.id;
        }
      }).catch(err => console.error('Sync error (addTask):', err));
      return task;
    };

    // ─── Patch deleteTask ───
    const _origDeleteTask = api.deleteTask.bind(api);
    api.deleteTask = function(id) {
      const task = store.tasks.find(t => t.id === id);
      _origDeleteTask(id);
      // In DB, mark as killed (not hard delete)
      if (task) {
        const killedVersion = store.killedTasks.find(t => t.killedAt &&
          (t.id === id || t.title === task.title));
        if (killedVersion) {
          DB.saveTask({ ...killedVersion, killed: true }).catch(err =>
            console.error('Sync error (deleteTask):', err));
        } else {
          DB.saveTask({ ...task, killed: true, killedAt: new Date().toISOString() }).catch(err =>
            console.error('Sync error (deleteTask):', err));
        }
      }
    };

    // ─── Patch voteUp ───
    const _origVoteUp = api.voteUp.bind(api);
    api.voteUp = function(id) {
      const task = _origVoteUp(id);
      persistTask(task);
      return task;
    };

    // ─── Patch moveToDrawer ───
    const _origMoveToDrawer = api.moveToDrawer.bind(api);
    api.moveToDrawer = function(id) {
      const task = _origMoveToDrawer(id);
      persistTask(task);
      persistTodayOrder();
      return task;
    };

    // ─── Patch moveFromDrawer ───
    const _origMoveFromDrawer = api.moveFromDrawer.bind(api);
    api.moveFromDrawer = function(id) {
      const task = _origMoveFromDrawer(id);
      persistTask(task);
      return task;
    };

    // ─── Patch setTaskDrawerCategory ───
    const _origSetCat = api.setTaskDrawerCategory.bind(api);
    api.setTaskDrawerCategory = function(id, catKey) {
      _origSetCat(id, catKey);
      const task = store.tasks.find(t => t.id === id);
      persistTask(task);
    };

    // ─── Patch toggleProject ───
    const _origToggleProject = api.toggleProject.bind(api);
    api.toggleProject = function(id) {
      const task = _origToggleProject(id);
      persistTask(task);
      return task;
    };

    // ─── Patch addTimeSession ───
    const _origAddTime = api.addTimeSession.bind(api);
    api.addTimeSession = function(id, date, minutes, note) {
      const task = _origAddTime(id, date, minutes, note);
      // Save time session to its own table AND update task
      persistTask(task);
      DB.saveTimeSession({ taskId: id, date, minutes, note: note || '' })
        .catch(err => console.error('Sync error (addTimeSession):', err));
      return task;
    };

    // ─── Patch deleteTimeSession ───
    const _origDelTime = api.deleteTimeSession.bind(api);
    api.deleteTimeSession = function(id, idx) {
      _origDelTime(id, idx);
      const task = store.tasks.find(t => t.id === id);
      persistTask(task);
    };

    // ─── Patch toggleDone ───
    const _origToggleDone = api.toggleDone.bind(api);
    api.toggleDone = function(id) {
      const task = _origToggleDone(id);
      persistTask(task);
      if (task && task.done) {
        // Log completion event
        DB.saveCompletionEvent().catch(err =>
          console.error('Sync error (completionEvent):', err));
        persistTodayOrder();
        // If recurring, the respawned task was already created by _origToggleDone
        // Find and persist the new task
        const respawned = store.tasks.find(t =>
          t.title === task.title && !t.done && t.id !== task.id && t.recurring);
        if (respawned) persistTask(respawned);
      }
      return task;
    };

    // ─── Patch removeFromToday ───
    const _origRemoveFromToday = api.removeFromToday.bind(api);
    api.removeFromToday = function(id) {
      const task = _origRemoveFromToday(id);
      persistTask(task);
      persistTodayOrder();
      return task;
    };

    // ─── Patch _reorderToday ───
    const _origReorder = api._reorderToday.bind(api);
    api._reorderToday = function() {
      _origReorder();
      persistTodayOrder();
    };

    // ─── Patch reorderToday (the public drag version) ───
    if (api.reorderToday) {
      const _origReorderPublic = api.reorderToday.bind(api);
      api.reorderToday = function(orderedIds) {
        _origReorderPublic(orderedIds);
        persistTodayOrder();
      };
    }

    // ─── Patch addDrawerCategory ───
    const _origAddCat = api.addDrawerCategory.bind(api);
    api.addDrawerCategory = function(key, label, color) {
      _origAddCat(key, label, color);
      DB.saveDrawerCategory({ key, label, color, sortOrder: Object.keys(store.drawerCategories).length })
        .catch(err => console.error('Sync error (addDrawerCategory):', err));
    };

    // ─── Patch deleteDrawerCategory ───
    const _origDelCat = api.deleteDrawerCategory.bind(api);
    api.deleteDrawerCategory = function(key) {
      _origDelCat(key);
      // Find the category in DB and delete it
      // We need to find by key — the DB stores as separate records
      DB.deleteDrawerCategory(key)
        .catch(err => console.error('Sync error (deleteDrawerCategory):', err));
    };

    // ─── Patch surfaceDrawerTasks ───
    const _origSurface = api.surfaceDrawerTasks.bind(api);
    api.surfaceDrawerTasks = function() {
      const surfaced = _origSurface();
      surfaced.forEach(t => persistTask(t));
      return surfaced;
    };

    console.log('✓ Sync layer active — mutations will persist to Supabase');
  }

  // Also patch saveCurrentNotes to persist after notes edit
  function patchNotesSave() {
    if (typeof saveCurrentNotes === 'undefined') {
      setTimeout(patchNotesSave, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) return;

    const _origSaveNotes = window.saveCurrentNotes;
    window.saveCurrentNotes = function() {
      _origSaveNotes();
      // Debounce the DB write for notes (they change on every keystroke)
      clearTimeout(window._notesSyncTimer);
      window._notesSyncTimer = setTimeout(() => {
        if (typeof currentNotesTaskId !== 'undefined' && currentNotesTaskId !== null) {
          const task = store.tasks.find(t => t.id === currentNotesTaskId);
          if (task) {
            DB.saveTask(task).catch(err => console.error('Sync error (notes):', err));
          }
        }
      }, 2000); // 2 second debounce for notes
    };
  }

  // Patch bumpCounter to log completion events
  function patchBumpCounter() {
    if (typeof bumpCounter === 'undefined') {
      setTimeout(patchBumpCounter, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) return;

    // bumpCounter already calls logCompletion() which adds to completionLog
    // We patch logCompletion instead
    if (typeof logCompletion !== 'undefined') {
      const _origLog = window.logCompletion;
      window.logCompletion = function() {
        _origLog();
        DB.saveCompletionEvent().catch(err =>
          console.error('Sync error (logCompletion):', err));
      };
    }
  }

  // Start patching after a short delay to ensure app.js has loaded
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      patchApiForSync();
      patchNotesSave();
      patchBumpCounter();
    }, 100);
  });

})();
