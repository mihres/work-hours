/* Work Hours PWA
 * Work records and photos are stored in IndexedDB.
 * Existing workHoursRecords localStorage data is migrated on first launch.
 */
"use strict";

const $ = id => document.getElementById(id);
const DB_NAME = "WorkHoursDatabase";
const DB_VERSION = 2;
const LEGACY_RECORDS_KEY = "workHoursRecords";
const ACCENT_KEY = "workHoursAccent";

let selectedDate = dateKey(new Date());
let currentView = "daily";
let currentMonth = new Date();
let currentPhotoId = null;
let db = null;
let records = {};
let photoURLs = [];
let notesSaveTimer = null;
let notesSaveQueue = Promise.resolve();
let expandedWeeks = new Set();

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function parseDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, amount) {
  const date = parseDate(key);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}
function mondayOf(key) {
  const date = parseDate(key);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return dateKey(date);
}
function formatDate(key, options = {}) {
  return parseDate(key).toLocaleDateString("en-AU", options);
}
function normalizeRecord(record) {
  return {
    shifts: Array.isArray(record?.shifts) ? record.shifts.map(s => ({
      start: typeof s?.start === "string" ? s.start : "",
      end: typeof s?.end === "string" ? s.end : ""
    })) : [],
    manual: Number.isFinite(record?.manual) ? Math.max(0, Math.floor(record.manual)) : null,
    notes: typeof record?.notes === "string" ? record.notes : ""
  };
}
function getRecord(key) {
  if (!records[key]) records[key] = { shifts: [], manual: null, notes: "" };
  else records[key] = normalizeRecord(records[key]);
  return records[key];
}
function formatMinutes(total) {
  total = Math.max(0, Math.floor(Number(total) || 0));
  return `${Math.floor(total / 60)} hr ${total % 60} min`;
}
function timeMinutes(value) {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
function shiftDuration(shift) {
  const start = timeMinutes(shift.start);
  const end = timeMinutes(shift.end);
  if (start === null || end === null) return 0;
  let duration = end - start;
  if (duration < 0) duration += 1440;
  return duration;
}
function isComplete(shift) {
  return Boolean(shift.start && shift.end);
}
function dayTotal(key) {
  const record = getRecord(key);
  if (record.manual !== null) return record.manual;
  return record.shifts.reduce((sum, shift) => sum + (isComplete(shift) ? shiftDuration(shift) : 0), 0);
}
function validShifts(key) {
  return getRecord(key).shifts.filter(isComplete);
}
function saveStatus(message = "All changes saved on this device") {
  $("saveStatus").textContent = message;
}
function showStorageError(action, error) {
  console.error(action, error);
  saveStatus(`${action} failed. Please keep the app open and try a backup.`);
}

/* IndexedDB setup. Version 2 adds a records store while preserving photos. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("photos")) {
        database.createObjectStore("photos", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("records")) {
        database.createObjectStore("records", { keyPath: "date" });
      }
    };
    request.onsuccess = () => {
      db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Could not open database"));
    request.onblocked = () => saveStatus("Storage update blocked. Close other app tabs and reopen.");
  });
}
function objectStore(storeName, mode = "readonly") {
  if (!db) throw new Error("Database is not ready");
  return db.transaction(storeName, mode).objectStore(storeName);
}
function getAllRecordsFromDB() {
  return new Promise((resolve, reject) => {
    const request = objectStore("records").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
function putRecordInDB(key, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").put({ date: key, ...normalizeRecord(record) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save record"));
    tx.onabort = () => reject(tx.error || new Error("Saving record was aborted"));
  });
}
function putAllRecordsInDB(source) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    for (const [key, value] of Object.entries(source)) {
      store.put({ date: key, ...normalizeRecord(value) });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save records"));
    tx.onabort = () => reject(tx.error || new Error("Saving records was aborted"));
  });
}
function clearRecordsInDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    tx.objectStore("records").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Clearing records was aborted"));
  });
}
function migrateLegacyRecords(legacy) {
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) return {};
  const migrated = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && value && typeof value === "object") {
      migrated[key] = normalizeRecord(value);
    }
  }
  return migrated;
}
async function loadRecords() {
  const storedRows = await getAllRecordsFromDB();
  const dbRecords = {};
  for (const row of storedRows) {
    if (row && typeof row.date === "string") dbRecords[row.date] = normalizeRecord(row);
  }

  let legacyRecords = {};
  try {
    const raw = localStorage.getItem(LEGACY_RECORDS_KEY);
    if (raw) legacyRecords = migrateLegacyRecords(JSON.parse(raw));
  } catch (error) {
    // Do not overwrite or remove the old key if it cannot be parsed.
    console.error("Legacy localStorage records could not be read.", error);
    saveStatus("Could not read old records. Existing data was left untouched.");
    throw new Error("The old work records could not be read. They have not been deleted.");
  }

  // IndexedDB wins for dates already present. Missing dates are migrated from localStorage.
  const merged = { ...legacyRecords, ...dbRecords };
  const missingLegacyRecords = {};
  for (const [key, value] of Object.entries(legacyRecords)) {
    if (!Object.prototype.hasOwnProperty.call(dbRecords, key)) {
      missingLegacyRecords[key] = value;
    }
  }
  const needsMigration = Object.keys(missingLegacyRecords).length > 0;
  records = merged;

  // Only add legacy dates missing from IndexedDB; never overwrite newer IndexedDB data.
  if (needsMigration) {
    await putAllRecordsInDB(missingLegacyRecords);
  }
  // Verify that the primary store can be read after writing before app is considered ready.
  const verifiedRows = await getAllRecordsFromDB();
  const verifiedDates = new Set(verifiedRows.map(row => row.date));
  for (const key of Object.keys(records)) {
    if (!verifiedDates.has(key)) throw new Error(`Saved record verification failed for ${key}`);
  }
  saveStatus(needsMigration ? "Work records migrated and saved" : "Work records loaded");
}

/* All work-record writes go through this serialized IndexedDB queue. */
let recordWriteQueue = Promise.resolve();
function saveRecord(key) {
  const snapshot = normalizeRecord(getRecord(key));
  recordWriteQueue = recordWriteQueue.catch(() => {}).then(() => putRecordInDB(key, snapshot));
  return recordWriteQueue.then(() => {
    saveStatus("Changes saved on this device");
  }).catch(error => {
    showStorageError("Saving work record", error);
    throw error;
  });
}
function saveAllRecords() {
  const snapshot = {};
  for (const [key, value] of Object.entries(records)) snapshot[key] = normalizeRecord(value);
  recordWriteQueue = recordWriteQueue.catch(() => {}).then(() => putAllRecordsInDB(snapshot));
  return recordWriteQueue.then(() => saveStatus("All work records saved on this device"))
    .catch(error => { showStorageError("Saving work records", error); throw error; });
}

/* Photo store (kept compatible with the existing v1 database). */
function photoTransaction(mode = "readonly") {
  return db.transaction("photos", mode).objectStore("photos");
}
function getPhotos(key) {
  return new Promise((resolve, reject) => {
    const request = photoTransaction().getAll();
    request.onsuccess = () => resolve(request.result.filter(photo => photo.date === key));
    request.onerror = () => reject(request.error);
  });
}
function allPhotos() {
  return new Promise((resolve, reject) => {
    const request = photoTransaction().getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
function savePhoto(photo) {
  return new Promise((resolve, reject) => {
    const request = photoTransaction("readwrite").put(photo);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}
function deleteStoredPhoto(id) {
  return new Promise((resolve, reject) => {
    const request = photoTransaction("readwrite").delete(id);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

/* DAILY VIEW */
function renderDaily() {
  const record = getRecord(selectedDate);
  $("dailyDay").textContent = formatDate(selectedDate, { weekday: "long" });
  $("dailyDate").textContent = formatDate(selectedDate, { day: "numeric", month: "long", year: "numeric" });
  $("shiftCount").textContent = `${record.shifts.length} shift${record.shifts.length === 1 ? "" : "s"}`;
  $("shiftList").innerHTML = "";

  record.shifts.forEach((shift, index) => {
    const card = document.createElement("div");
    card.className = "shift-card";
    const top = document.createElement("div");
    top.className = "shift-top";
    const heading = document.createElement("span");
    heading.className = "shift-number";
    heading.textContent = `Shift ${index + 1}`;
    top.append(heading);

    const remove = document.createElement("button");
    remove.className = "text-btn danger-text";
    remove.textContent = "Remove";
    remove.onclick = async () => {
      record.shifts.splice(index, 1);
      try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
      catch { alert("This shift could not be saved. Please keep the app open and try again."); }
    };
    top.append(remove);

    const fields = document.createElement("div");
    fields.className = "shift-fields";
    ["start", "end"].forEach(field => {
      const wrapper = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = field === "start" ? "START TIME" : "END TIME";
      const input = document.createElement("input");
      input.type = "time";
      input.value = shift[field] || "";
      input.setAttribute("aria-label", `Shift ${index + 1} ${field} time`);
      input.addEventListener("change", async () => {
        shift[field] = input.value;
        try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
        catch { alert("This change could not be saved. Please try again."); }
      });
      wrapper.append(label, input);
      fields.append(wrapper);
    });

    const duration = document.createElement("div");
    duration.className = "shift-duration";
    duration.textContent = isComplete(shift) ? `Shift total: ${formatMinutes(shiftDuration(shift))}` : "Enter both times to calculate this shift";
    card.append(top, fields, duration);
    $("shiftList").append(card);
  });

  $("dailyTotal").textContent = formatMinutes(dayTotal(selectedDate));
  $("manualPanel").classList.toggle("hidden", record.manual === null);
  if (record.manual !== null) {
    $("manualHours").value = Math.floor(record.manual / 60);
    $("manualMinutes").value = record.manual % 60;
  }
  $("notesPanel").classList.toggle("hidden", !record.notes && document.activeElement !== $("dailyNotes"));
  $("notesToggle").textContent = record.notes ? "Edit notes" : "＋ Add notes";
  $("dailyNotes").value = record.notes;
  $("notesPreview").textContent = record.notes || "No notes added.";
  $("notesPreview").classList.toggle("hidden", !record.notes);
  renderPhotos().catch(error => showStorageError("Loading photos", error));
}

$("addShiftBtn").onclick = async () => {
  getRecord(selectedDate).shifts.push({ start: "", end: "" });
  try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
  catch { alert("The new shift could not be saved. Please try again."); }
};
$("prevDay").onclick = () => { selectedDate = addDays(selectedDate, -1); renderDaily(); };
$("nextDay").onclick = () => { selectedDate = addDays(selectedDate, 1); renderDaily(); };
$("manualBtn").onclick = () => $("manualPanel").classList.toggle("hidden");
$("saveManualBtn").onclick = async () => {
  const hours = Number($("manualHours").value);
  const minutes = Number($("manualMinutes").value);
  if (!Number.isInteger(hours) || hours < 0 || hours > 999 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    alert("Please enter valid hours and minutes."); return;
  }
  getRecord(selectedDate).manual = hours * 60 + minutes;
  try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
  catch { alert("The manual total could not be saved."); }
};
$("autoTotalBtn").onclick = async () => {
  getRecord(selectedDate).manual = null;
  try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
  catch { alert("The automatic total setting could not be saved."); }
};
$("notesToggle").onclick = () => {
  $("notesPanel").classList.toggle("hidden");
  if (!$("notesPanel").classList.contains("hidden")) $("dailyNotes").focus();
};
$("dailyNotes").addEventListener("input", () => {
  const key = selectedDate;
  getRecord(key).notes = $("dailyNotes").value;
  $("notesPreview").textContent = $("dailyNotes").value || "No notes added.";
  $("notesPreview").classList.toggle("hidden", !$("dailyNotes").value);
  $("notesToggle").textContent = $("dailyNotes").value ? "Edit notes" : "＋ Add notes";
  $("notesStatus").textContent = "Saving…";
  saveStatus("Saving notes…");
  clearTimeout(notesSaveTimer);
  // Queue a snapshot after the user pauses typing. The snapshot is made at save time.
  notesSaveTimer = setTimeout(() => {
    notesSaveQueue = notesSaveQueue.then(async () => {
      try {
        await saveRecord(key);
        if (selectedDate === key) $("notesStatus").textContent = "Saved automatically";
      } catch {
        if (selectedDate === key) $("notesStatus").textContent = "Save failed — try again";
      }
    });
  }, 350);
});
$("clearNotesBtn").onclick = async () => {
  if (!confirm("Delete these daily notes?")) return;
  getRecord(selectedDate).notes = "";
  try { await saveRecord(selectedDate); renderDaily(); renderWeekly(); renderHistory(); }
  catch { alert("The notes could not be cleared from storage."); }
};

/* PHOTO HANDLING */
$("cameraInput").addEventListener("change", async event => {
  const files = [...event.target.files];
  try {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const compressed = await compressImage(file);
      await savePhoto({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, date: selectedDate, blob: compressed, created: Date.now() });
    }
    await renderPhotos();
    await renderHistory();
    saveStatus("Photos saved on this device");
  } catch (error) {
    console.error(error);
    alert("Unable to save photo. Check available browser storage.");
  }
  event.target.value = "";
});
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1800;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob); else reject(new Error("Image compression failed"));
      }, "image/jpeg", 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Unable to read image")); };
    img.src = url;
  });
}
async function renderPhotos() {
  photoURLs.forEach(url => URL.revokeObjectURL(url));
  photoURLs = [];
  const photos = await getPhotos(selectedDate);
  $("photoCount").textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"}`;
  const gallery = $("photoGallery");
  gallery.innerHTML = "";
  photos.sort((a, b) => a.created - b.created);
  photos.forEach(photo => {
    const url = URL.createObjectURL(photo.blob);
    photoURLs.push(url);
    const img = document.createElement("img");
    img.src = url; img.className = "photo-thumb"; img.alt = "Work photo";
    img.onclick = () => openPhoto(photo.id, url);
    gallery.append(img);
  });
}
function openPhoto(id, url) {
  currentPhotoId = id;
  $("largePhoto").src = url;
  $("photoModal").classList.remove("hidden");
}
$("closePhoto").onclick = () => {
  $("photoModal").classList.add("hidden");
  $("largePhoto").src = "";
  currentPhotoId = null;
};
$("deletePhoto").onclick = async () => {
  if (!currentPhotoId || !confirm("Delete this photo permanently?")) return;
  try {
    await deleteStoredPhoto(currentPhotoId);
    $("photoModal").classList.add("hidden");
    $("largePhoto").src = "";
    currentPhotoId = null;
    await renderPhotos(); await renderHistory();
    saveStatus("Photo deleted");
  } catch (error) { showStorageError("Deleting photo", error); }
};

/* WEEKLY VIEW */
function weekKeys(key) {
  const monday = mondayOf(key);
  return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
}
function weeklyTotal(key) {
  return weekKeys(key).reduce((sum, day) => sum + dayTotal(day), 0);
}
function displayTime(key) {
  const shifts = validShifts(key);
  if (!shifts.length) return { start: "—", end: "—" };
  return { start: shifts[0].start, end: shifts[shifts.length - 1].end };
}
function renderWeekly() {
  const keys = weekKeys(selectedDate);
  $("weekRange").textContent = `${formatDate(keys[0], { day: "numeric", month: "short" })} – ${formatDate(keys[4], { day: "numeric", month: "short", year: "numeric" })}`;
  const table = $("weeklyTable");
  table.innerHTML = "";
  keys.forEach(key => {
    const times = displayTime(key);
    const row = document.createElement("tr");
    const dayCell = document.createElement("td");
    const link = document.createElement("button");
    link.className = "day-link";
    link.textContent = formatDate(key, { weekday: "short", day: "numeric" });
    link.onclick = () => openDay(key);
    dayCell.append(link);
    const start = document.createElement("td"); start.textContent = times.start;
    const end = document.createElement("td"); end.textContent = times.end;
    const total = document.createElement("td"); total.className = "table-total"; total.textContent = formatMinutes(dayTotal(key));
    row.append(dayCell, start, end, total); table.append(row);
  });
  const total = formatMinutes(weeklyTotal(selectedDate));
  $("weeklyTotal").textContent = total;
  $("weeklyStatement").textContent = `I have '${total}' hours this week.`;
}
$("prevWeek").onclick = () => { selectedDate = addDays(mondayOf(selectedDate), -7); renderWeekly(); };
$("nextWeek").onclick = () => { selectedDate = addDays(mondayOf(selectedDate), 7); renderWeekly(); };
$("copyBtn").onclick = async () => {
  const statement = `I have '${formatMinutes(weeklyTotal(selectedDate))}' hours this week.`;
  try {
    await navigator.clipboard.writeText(statement);
  } catch {
    const field = document.createElement("textarea");
    field.value = statement; document.body.append(field); field.select(); document.execCommand("copy"); field.remove();
  }
  $("copyBtn").textContent = "✓ Copied!";
  setTimeout(() => $("copyBtn").textContent = "▢ Copy summary", 1800);
};
$("csvBtn").onclick = () => {
  const keys = weekKeys(selectedDate);
  const rows = [["Date", "Day", "Shift", "Start", "End", "Shift total (minutes)", "Daily total (minutes)", "Manual override", "Notes"]];
  keys.forEach(key => {
    const record = getRecord(key);
    const complete = validShifts(key);
    if (!complete.length) {
      rows.push([key, formatDate(key, { weekday: "long" }), "", "", "", "", dayTotal(key), record.manual !== null ? "Yes" : "No", record.notes]);
    } else {
      complete.forEach((shift, i) => rows.push([
        key, formatDate(key, { weekday: "long" }), i + 1, shift.start, shift.end,
        shiftDuration(shift), i === 0 ? dayTotal(key) : "",
        i === 0 && record.manual !== null ? "Yes" : "", i === 0 ? record.notes : ""
      ]));
    }
  });
  const csv = rows.map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `Work-Hours-${mondayOf(selectedDate)}.csv`, "text/csv;charset=utf-8;");
};

/* HISTORY */
async function renderHistory() {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  $("monthLabel").textContent = currentMonth.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const photoList = await allPhotos();
  const allDates = new Set([...Object.keys(records), ...photoList.map(photo => photo.date)]);
  const keys = [...allDates].filter(key => {
    const d = parseDate(key);
    const record = getRecord(key);
    const hasRecord = record.shifts.length > 0 || record.manual !== null || Boolean(record.notes);
    const hasPhotos = photoList.some(photo => photo.date === key);
    return d.getFullYear() === year && d.getMonth() === month && (hasRecord || hasPhotos);
  });
  const total = keys.reduce((sum, key) => sum + dayTotal(key), 0);
  $("monthlyTotal").textContent = formatMinutes(total);
  $("monthlyDays").textContent = keys.filter(key => dayTotal(key) > 0).length;
  const photoCounts = {};
  photoList.forEach(photo => { photoCounts[photo.date] = (photoCounts[photo.date] || 0) + 1; });
  const weeks = new Map();
  keys.forEach(key => {
    const monday = mondayOf(key);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push(key);
  });
  const list = $("historyList");
  list.innerHTML = "";
  if (!weeks.size) {
    list.innerHTML = '<div class="history-empty">No saved records for this month yet.</div>';
    return;
  }
  [...weeks.keys()].sort().reverse().forEach(monday => {
    const weekDays = weeks.get(monday).sort();
    const weekTotal = weekDays.reduce((sum, key) => sum + dayTotal(key), 0);
    const friday = addDays(monday, 4);
    const card = document.createElement("div"); card.className = "history-week";
    const header = document.createElement("div"); header.className = "history-week-header"; header.setAttribute("role", "button"); header.tabIndex = 0;
    const heading = document.createElement("strong");
    heading.textContent = `${formatDate(monday, { day: "numeric", month: "short" })} – ${formatDate(friday, { day: "numeric", month: "short" })}`;
    const amount = document.createElement("span"); amount.className = "table-total"; amount.textContent = formatMinutes(weekTotal);
    header.append(heading, amount);
    const body = document.createElement("div"); body.className = "history-week-body";
    weekDays.forEach(key => {
      const item = document.createElement("div"); item.className = "history-day";
      const left = document.createElement("div");
      const open = document.createElement("button");
      open.textContent = formatDate(key, { weekday: "short", day: "numeric", month: "short" });
      open.onclick = () => openDay(key);
      const info = document.createElement("small");
      const details = [];
      if (getRecord(key).notes) details.push("Notes saved");
      const photos = photoCounts[key] || 0;
      if (photos) details.push(`${photos} photo${photos === 1 ? "" : "s"}`);
      if (!details.length) details.push("No notes or photos");
      info.textContent = details.join(" · ");
      left.append(open, info);
      const right = document.createElement("strong"); right.className = "table-total"; right.textContent = formatMinutes(dayTotal(key));
      item.append(left, right); body.append(item);
    });
    const openWeek = document.createElement("button");
    openWeek.className = "secondary-btn"; openWeek.style.width = "100%"; openWeek.style.marginTop = "13px"; openWeek.textContent = "View this week";
    openWeek.onclick = () => { selectedDate = monday; showView("weekly"); };
    body.append(openWeek);
    const toggle = () => {
      body.classList.toggle("hidden");
      if (body.classList.contains("hidden")) expandedWeeks.delete(monday); else expandedWeeks.add(monday);
    };
    header.onclick = toggle;
    header.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } };
    if (!expandedWeeks.has(monday)) body.classList.add("hidden");
    card.append(header, body); list.append(card);
  });
}
$("prevMonth").onclick = () => { currentMonth.setMonth(currentMonth.getMonth() - 1); renderHistory(); };
$("nextMonth").onclick = () => { currentMonth.setMonth(currentMonth.getMonth() + 1); renderHistory(); };

/* NAVIGATION */
function openDay(key) { selectedDate = key; showView("daily"); }
function showView(view) {
  currentView = view;
  ["daily", "weekly", "history"].forEach(name => $(name + "View").classList.toggle("hidden", name !== view));
  document.querySelectorAll(".nav-btn").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (view === "daily") renderDaily();
  if (view === "weekly") renderWeekly();
  if (view === "history") renderHistory().catch(error => showStorageError("Loading history", error));
}
document.querySelectorAll(".nav-btn").forEach(button => { button.onclick = () => showView(button.dataset.view); });

/* SETTINGS */
$("settingsBtn").onclick = () => $("settingsPanel").classList.toggle("hidden");
$("accentSelect").onchange = () => {
  const colour = $("accentSelect").value;
  document.documentElement.style.setProperty("--accent", colour);
  try { localStorage.setItem(ACCENT_KEY, colour); } catch (error) { console.warn("Could not save accent colour", error); }
};
function loadAccent() {
  try {
    const savedAccent = localStorage.getItem(ACCENT_KEY);
    if (savedAccent) {
      const valid = [...$("accentSelect").options].some(option => option.value === savedAccent);
      if (valid) {
        $("accentSelect").value = savedAccent;
        document.documentElement.style.setProperty("--accent", savedAccent);
      }
    }
  } catch (error) { console.warn("Could not load accent colour", error); }
}

/* BACKUP / RESTORE */
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}
$("backupBtn").onclick = async () => {
  try {
    await recordWriteQueue;
    const photos = await allPhotos();
    const backupPhotos = [];
    for (const photo of photos) {
      backupPhotos.push({ id: photo.id, date: photo.date, created: photo.created, type: photo.blob.type, data: await blobToBase64(photo.blob) });
    }
    const backup = { version: 2, records: Object.fromEntries(Object.entries(records).map(([key, value]) => [key, normalizeRecord(value)])), photos: backupPhotos };
    downloadFile(JSON.stringify(backup), `Work-Hours-Backup-${dateKey(new Date())}.json`, "application/json");
    saveStatus("Backup created");
  } catch (error) {
    console.error(error);
    alert("Backup failed. Please check available storage and try again.");
  }
};
$("restoreBtn").onclick = () => $("restoreFile").click();
$("restoreFile").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm("Restore this backup? This replaces existing records and photos.")) { event.target.value = ""; return; }
  try {
    const backup = JSON.parse(await file.text());
    if (![1, 2].includes(backup.version) || !backup.records || typeof backup.records !== "object" || Array.isArray(backup.records) || !Array.isArray(backup.photos)) {
      throw new Error("Invalid backup file");
    }
    const cleanRecords = migrateLegacyRecords(backup.records);
    const cleanPhotos = backup.photos.map(photo => {
      if (!photo || typeof photo.id !== "string" || typeof photo.date !== "string" || typeof photo.data !== "string") throw new Error("Invalid photo entry");
      return { id: photo.id, date: photo.date, created: Number(photo.created) || Date.now(), blob: base64ToBlob(photo.data, photo.type) };
    });
    // Prepare and validate the file before changing existing data.
    await clearRecordsInDB();
    await putAllRecordsInDB(cleanRecords);
    for (const photo of await allPhotos()) await deleteStoredPhoto(photo.id);
    for (const photo of cleanPhotos) await savePhoto(photo);
    records = cleanRecords;
    await renderDaily(); renderWeekly(); await renderHistory();
    saveStatus("Backup restored");
    alert("Backup restored successfully.");
  } catch (error) {
    console.error("Restore failed", error);
    alert("Unable to restore this backup. Existing data may be partially changed if storage ran out of space. Please reload the app.");
  }
  event.target.value = "";
};

/* RESET */
$("resetBtn").onclick = async () => {
  if (!confirm("Permanently delete ALL hours, notes and photos? Make a backup first if needed.")) return;
  try {
    await clearRecordsInDB();
    for (const photo of await allPhotos()) await deleteStoredPhoto(photo.id);
    records = {};
    try { localStorage.removeItem(LEGACY_RECORDS_KEY); } catch {}
    selectedDate = dateKey(new Date());
    currentMonth = new Date();
    $("settingsPanel").classList.add("hidden");
    renderDaily(); renderWeekly(); await renderHistory();
    saveStatus("All work records and photos deleted");
  } catch (error) {
    showStorageError("Resetting app data", error);
    alert("The app could not reset all data. Please try again.");
  }
};

/* SERVICE WORKER */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(error => {
      console.error("Service worker registration failed", error);
      saveStatus("Offline update registration failed; online use may still work");
    });
  });
}

/* STARTUP */
async function startApp() {
  try {
    loadAccent();
    await openDatabase();
    await loadRecords();
    if (navigator.storage?.persist) {
      navigator.storage.persist().then(granted => {
        console.info("Persistent storage request:", granted ? "granted" : "not granted");
      }).catch(() => {});
    }
    renderDaily();
    renderWeekly();
    await renderHistory();
    saveStatus("Ready — changes save to this device");
  } catch (error) {
    console.error("App startup error", error);
    saveStatus("Storage could not be opened. Your records were not reset.");
    alert("Work Hours could not open its saved data. The app has not intentionally cleared your records. Close and reopen the app; if this continues, use a backup if available.");
  }
}
startApp();
