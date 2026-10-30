
const $ = id => document.getElementById(id);

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

let selectedDate = dateKey(new Date());
let currentView = "daily";
let currentMonth = new Date();
let currentPhotoId = null;
let db;
let records = {};
let photoURLs = [];

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

function getRecord(key) {
  if (!records[key]) {
    records[key] = {
      shifts: [],
      manual: null,
      notes: ""
    };
  }

  return records[key];
}

function formatMinutes(total) {
  total = Math.max(0, Math.floor(total || 0));
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

  return record.shifts.reduce((sum, shift) => {
    return sum + (isComplete(shift) ? shiftDuration(shift) : 0);
  }, 0);
}

function validShifts(key) {
  return getRecord(key).shifts.filter(isComplete);
}

function saveStatus(message = "All changes saved locally") {
  $("saveStatus").textContent = message;
}

function saveData() {
  try {
    const data = JSON.stringify(records);

    localStorage.setItem("workHoursRecords", data);

    // Verify that the saved data can be read back.
    const saved = localStorage.getItem("workHoursRecords");

    if (saved !== data) {
      throw new Error("Saved data verification failed");
    }

    saveStatus("All changes saved locally");

    console.log("Work records saved successfully.", {
      origin: location.origin,
      recordCount: Object.keys(records).length,
      storageBytes: new Blob([data]).size
    });

  } catch (error) {
    console.error("Failed to save work records:", error);

    saveStatus("Storage error – check browser settings");

    alert(
      "Unable to save your work records. " +
      "Please export a backup if possible.\n\n" +
      error.message
    );
  }
}

// DATABASE FOR PHOTOS

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("WorkHoursDatabase", 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("photos")) {
        database.createObjectStore("photos", { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function photoTransaction(mode = "readonly") {
  return db.transaction("photos", mode).objectStore("photos");
}

function getPhotos(key) {
  return new Promise((resolve, reject) => {
    const request = photoTransaction().getAll();
    request.onsuccess = () => {
      resolve(request.result.filter(photo => photo.date === key));
    };
    request.onerror = () => reject(request.error);
  });
}

function allPhotos() {
  return new Promise((resolve, reject) => {
    const request = photoTransaction().getAll();
    request.onsuccess = () => resolve(request.result);
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

// DAILY VIEW

function renderDaily() {
  const record = getRecord(selectedDate);
  const date = parseDate(selectedDate);

  $("dailyDay").textContent = date.toLocaleDateString("en-AU", {
    weekday: "long"
  });

  $("dailyDate").textContent = formatDate(selectedDate, {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  $("shiftCount").textContent =
    `${record.shifts.length} shift${record.shifts.length === 1 ? "" : "s"}`;

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

    if (record.shifts.length > 0) {
      const remove = document.createElement("button");
      remove.className = "text-btn danger-text";
      remove.textContent = "Remove";

      remove.onclick = () => {
        record.shifts.splice(index, 1);
        saveData();
        renderDaily();
        renderWeekly();
      };

      top.append(remove);
    }

    const fields = document.createElement("div");
    fields.className = "shift-fields";

    ["start", "end"].forEach(field => {
      const wrapper = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = field === "start" ? "START TIME" : "END TIME";

      const input = document.createElement("input");
      input.type = "time";
      input.value = shift[field] || "";
      input.addEventListener("change", () => {
        shift[field] = input.value;
        saveData();
        renderDaily();
        renderWeekly();
      });

      wrapper.append(label, input);
      fields.append(wrapper);
    });

    const duration = document.createElement("div");
    duration.className = "shift-duration";
    duration.textContent = isComplete(shift)
      ? `Shift total: ${formatMinutes(shiftDuration(shift))}`
      : "Enter both times to calculate this shift";

    card.append(top, fields, duration);
    $("shiftList").append(card);
  });

  $("dailyTotal").textContent = formatMinutes(dayTotal(selectedDate));

  $("manualPanel").classList.toggle("hidden", record.manual === null);

  if (record.manual !== null) {
    $("manualHours").value = Math.floor(record.manual / 60);
    $("manualMinutes").value = record.manual % 60;
  }

  $("notesPanel").classList.toggle("hidden", !record.notes);
  $("notesToggle").textContent = record.notes ? "Edit notes" : "+ Add notes";
  $("dailyNotes").value = record.notes;
  $("notesPreview").textContent = record.notes || "No notes added.";
  $("notesPreview").classList.toggle("hidden", !record.notes);

  renderPhotos();
}

$("addShiftBtn").onclick = () => {
  getRecord(selectedDate).shifts.push({
    start: "",
    end: ""
  });

  saveData();
  renderDaily();
};

$("prevDay").onclick = () => {
  selectedDate = addDays(selectedDate, -1);
  renderDaily();
};

$("nextDay").onclick = () => {
  selectedDate = addDays(selectedDate, 1);
  renderDaily();
};

$("manualBtn").onclick = () => {
  $("manualPanel").classList.toggle("hidden");
};

$("saveManualBtn").onclick = () => {
  const hours = Number($("manualHours").value);
  const minutes = Number($("manualMinutes").value);

  if (!Number.isInteger(hours) || hours < 0 ||
      !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    alert("Please enter valid hours and minutes.");
    return;
  }

  getRecord(selectedDate).manual = hours * 60 + minutes;
  saveData();
  renderDaily();
  renderWeekly();
};

$("autoTotalBtn").onclick = () => {
  getRecord(selectedDate).manual = null;
  saveData();
  renderDaily();
  renderWeekly();
};

$("notesToggle").onclick = () => {
  $("notesPanel").classList.toggle("hidden");
  $("dailyNotes").focus();
};

$("dailyNotes").addEventListener("input", () => {
  const value = $("dailyNotes").value;

  getRecord(selectedDate).notes = value;

  $("notesPreview").textContent = value || "No notes added.";
  $("notesPreview").classList.toggle("hidden", !value);
  $("notesToggle").textContent = value ? "Edit notes" : "+ Add notes";

  saveData();
});

$("clearNotesBtn").onclick = () => {
  if (!confirm("Delete these daily notes?")) return;

  getRecord(selectedDate).notes = "";
  saveData();
  renderDaily();
};

// PHOTO HANDLING

$("cameraInput").addEventListener("change", async event => {
  const files = [...event.target.files];

  try {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;

      // Compress large camera images to reduce storage usage.
      const compressed = await compressImage(file);

      await savePhoto({
        id: crypto.randomUUID(),
        date: selectedDate,
        blob: compressed,
        created: Date.now()
      });
    }

    getRecord(selectedDate);
saveData();
await renderPhotos();
renderHistory();
saveStatus("Photos saved on this device");
  } catch (error) {
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
        if (blob) resolve(blob);
        else reject(new Error("Image compression failed"));
      }, "image/jpeg", 0.82);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read image"));
    };

    img.src = url;
  });
}

async function renderPhotos() {
  photoURLs.forEach(url => URL.revokeObjectURL(url));
  photoURLs = [];

  const photos = await getPhotos(selectedDate);

  $("photoCount").textContent =
    `${photos.length} photo${photos.length === 1 ? "" : "s"}`;

  const gallery = $("photoGallery");
  gallery.innerHTML = "";

  photos.sort((a, b) => a.created - b.created);

  photos.forEach(photo => {
    const url = URL.createObjectURL(photo.blob);
    photoURLs.push(url);

    const img = document.createElement("img");
    img.src = url;
    img.className = "photo-thumb";
    img.alt = "Work photo";
    img.onclick = () => openPhoto(photo.id, url);

    gallery.append(img);
  });
}

async function openPhoto(id, url) {
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
  if (!currentPhotoId) return;
  if (!confirm("Delete this photo permanently?")) return;

  await deleteStoredPhoto(currentPhotoId);
  $("photoModal").classList.add("hidden");
  $("largePhoto").src = "";
  currentPhotoId = null;

  await renderPhotos();
  renderHistory();
};

// WEEKLY VIEW

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

  return {
    start: shifts[0].start,
    end: shifts[shifts.length - 1].end
  };
}

function renderWeekly() {
  const keys = weekKeys(selectedDate);
  const monday = parseDate(keys[0]);
  const friday = parseDate(keys[4]);

  $("weekRange").textContent =
    `${formatDate(keys[0], { day: "numeric", month: "short" })} – ` +
    formatDate(keys[4], { day: "numeric", month: "short", year: "numeric" });

  const table = $("weeklyTable");
  table.innerHTML = "";

  keys.forEach(key => {
    const times = displayTime(key);
    const row = document.createElement("tr");

    const dayCell = document.createElement("td");
    const link = document.createElement("button");
    link.className = "day-link";
    link.textContent = formatDate(key, {
      weekday: "short",
      day: "numeric"
    });
    link.onclick = () => openDay(key);
    dayCell.append(link);

    const start = document.createElement("td");
    start.textContent = times.start;

    const end = document.createElement("td");
    end.textContent = times.end;

    const total = document.createElement("td");
    total.className = "table-total";
    total.textContent = formatMinutes(dayTotal(key));

    row.append(dayCell, start, end, total);
    table.append(row);
  });

  const total = formatMinutes(weeklyTotal(selectedDate));
  $("weeklyTotal").textContent = total;
  $("weeklyStatement").textContent =
    `I have '${total}' hours this week.`;
}

$("prevWeek").onclick = () => {
  selectedDate = addDays(mondayOf(selectedDate), -7);
  renderWeekly();
};

$("nextWeek").onclick = () => {
  selectedDate = addDays(mondayOf(selectedDate), 7);
  renderWeekly();
};

$("copyBtn").onclick = async () => {
  const total = formatMinutes(weeklyTotal(selectedDate));
  const statement = `I have '${total}' hours this week.`;

  try {
    await navigator.clipboard.writeText(statement);
    $("copyBtn").textContent = "✓ Copied!";
  } catch {
    const field = document.createElement("textarea");
    field.value = statement;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    $("copyBtn").textContent = "✓ Copied!";
  }

  setTimeout(() => $("copyBtn").textContent = "▢ Copy summary", 1800);
};

$("csvBtn").onclick = () => {
  const keys = weekKeys(selectedDate);

  const rows = [
    ["Date", "Day", "Shift", "Start", "End", "Shift total", "Daily total", "Manual override", "Notes"]
  ];

  keys.forEach(key => {
    const record = getRecord(key);
    const complete = validShifts(key);

    if (!complete.length) {
      rows.push([
        key,
        formatDate(key, { weekday: "long" }),
        "",
        "",
        "",
        "",
        dayTotal(key),
        record.manual !== null ? "Yes" : "No",
        record.notes
      ]);
    } else {
      complete.forEach((shift, i) => {
        rows.push([
          key,
          formatDate(key, { weekday: "long" }),
          i + 1,
          shift.start,
          shift.end,
          shiftDuration(shift),
          i === 0 ? dayTotal(key) : "",
          i === 0 && record.manual !== null ? "Yes" : "",
          i === 0 ? record.notes : ""
        ]);
      });
    }
  });

  const csv = rows.map(row =>
    row.map(value =>
      `"${String(value ?? "").replace(/"/g, '""')}"`
    ).join(",")
  ).join("\r\n");

  downloadFile(
    csv,
    `Work-Hours-${mondayOf(selectedDate)}.csv`,
    "text/csv;charset=utf-8;"
  );
};

// HISTORY

let expandedWeeks = new Set();


async function renderHistory() {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  // Display current month
  $("monthLabel").textContent = currentMonth.toLocaleDateString(
    "en-AU",
    { month: "long", year: "numeric" }
  );

  // Retrieve all stored photos
  const photoList = await allPhotos();

  // Combine dates from work records and photos
  const allDates = new Set([
    ...Object.keys(records),
    ...photoList.map(photo => photo.date)
  ]);

  // Only include dates belonging to the selected month
  // and containing actual records, notes, shifts or photos
  const keys = [...allDates].filter(key => {
    const d = parseDate(key);
    const record = getRecord(key);

    const hasRecord =
      record.shifts.length > 0 ||
      record.manual !== null ||
      Boolean(record.notes);

    const hasPhotos = photoList.some(
      photo => photo.date === key
    );

    return (
      d.getFullYear() === year &&
      d.getMonth() === month &&
      (hasRecord || hasPhotos)
    );
  });

  // Calculate monthly statistics
  const total = keys.reduce(
    (sum, key) => sum + dayTotal(key),
    0
  );

  const days = keys.filter(
    key => dayTotal(key) > 0
  ).length;

  $("monthlyTotal").textContent = formatMinutes(total);
  $("monthlyDays").textContent = days;

  // Count photos for each date
  const photoCounts = {};

  photoList.forEach(photo => {
    photoCounts[photo.date] =
      (photoCounts[photo.date] || 0) + 1;
  });

  // Group dates into weeks
  const weeks = new Map();

  keys.forEach(key => {
    const monday = mondayOf(key);

    if (!weeks.has(monday)) {
      weeks.set(monday, []);
    }

    weeks.get(monday).push(key);
  });

  const list = $("historyList");
  list.innerHTML = "";

  // Show empty message if no records exist
  if (!weeks.size) {
    list.innerHTML = `
      <div class="history-empty">
        No saved records for this month yet.
      </div>
    `;
    return;
  }

  // Display newest weeks first
  [...weeks.keys()].sort().reverse().forEach(monday => {

    const weekDays = weeks.get(monday).sort();

    const weekTotal = weekDays.reduce(
      (sum, key) => sum + dayTotal(key),
      0
    );

    const friday = addDays(monday, 4);

    const card = document.createElement("div");
    card.className = "history-week";

    // Week heading
    const header = document.createElement("div");
    header.className = "history-week-header";

    const heading = document.createElement("strong");

    heading.textContent =
      `${formatDate(monday, {
        day: "numeric",
        month: "short"
      })} – ` +
      formatDate(friday, {
        day: "numeric",
        month: "short"
      });

    const amount = document.createElement("span");
    amount.className = "table-total";
    amount.textContent = formatMinutes(weekTotal);

    header.append(heading, amount);

    // Week details
    const body = document.createElement("div");
    body.className = "history-week-body";

    weekDays.forEach(key => {

      const item = document.createElement("div");
      item.className = "history-day";

      const left = document.createElement("div");

      // Click date to open its daily record
      const open = document.createElement("button");

      open.textContent = formatDate(key, {
        weekday: "short",
        day: "numeric",
        month: "short"
      });

      open.onclick = () => openDay(key);

      // Show notes and photo information
      const info = document.createElement("small");

      const photos = photoCounts[key] || 0;

      const details = [];

      if (getRecord(key).notes) {
        details.push("Notes saved");
      }

      if (photos) {
        details.push(
          `${photos} photo${photos === 1 ? "" : "s"}`
        );
      }

      if (!details.length) {
        details.push("No notes or photos");
      }

      info.textContent = details.join(" · ");

      left.append(open, info);

      // Daily hours
      const right = document.createElement("strong");
      right.className = "table-total";
      right.textContent = formatMinutes(dayTotal(key));

      item.append(left, right);
      body.append(item);
    });

    // Open weekly overview
    const openWeek = document.createElement("button");

    openWeek.className = "secondary-btn";
    openWeek.style.width = "100%";
    openWeek.style.marginTop = "13px";
    openWeek.textContent = "View this week";

    openWeek.onclick = () => {
      selectedDate = monday;
      showView("weekly");
    };

    body.append(openWeek);

    // Expand or collapse week
    header.onclick = () => {
      body.classList.toggle("hidden");

      if (body.classList.contains("hidden")) {
        expandedWeeks.delete(monday);
      } else {
        expandedWeeks.add(monday);
      }
    };

    // Weeks are collapsed by default
    if (!expandedWeeks.has(monday)) {
      body.classList.add("hidden");
    }

    card.append(header, body);
    list.append(card);
  });
}


$("prevMonth").onclick = () => {
  currentMonth.setMonth(currentMonth.getMonth() - 1);
  renderHistory();
};

$("nextMonth").onclick = () => {
  currentMonth.setMonth(currentMonth.getMonth() + 1);
  renderHistory();
};

// NAVIGATION

function openDay(key) {
  selectedDate = key;
  showView("daily");
}

function showView(view) {
  currentView = view;

  ["daily", "weekly", "history"].forEach(name => {
    $(name + "View").classList.toggle("hidden", name !== view);
  });

  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  if (view === "daily") renderDaily();
  if (view === "weekly") renderWeekly();
  if (view === "history") renderHistory();
}

document.querySelectorAll(".nav-btn").forEach(button => {
  button.onclick = () => showView(button.dataset.view);
});

// SETTINGS AND COLOURS

$("settingsBtn").onclick = () => {
  $("settingsPanel").classList.toggle("hidden");
};

$("accentSelect").onchange = () => {
  const colour = $("accentSelect").value;
  document.documentElement.style.setProperty("--accent", colour);
  localStorage.setItem("workHoursAccent", colour);
};

const savedAccent = localStorage.getItem("workHoursAccent");
if (savedAccent) {
  $("accentSelect").value = savedAccent;
  document.documentElement.style.setProperty("--accent", savedAccent);
}

// BACKUP AND RESTORE

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type });
}

$("backupBtn").onclick = async () => {
  try {
    const photos = await allPhotos();
    const backupPhotos = [];

    for (const photo of photos) {
      backupPhotos.push({
        id: photo.id,
        date: photo.date,
        created: photo.created,
        type: photo.blob.type,
        data: await blobToBase64(photo.blob)
      });
    }

    const backup = {
      version: 1,
      records,
      photos: backupPhotos
    };

    downloadFile(
      JSON.stringify(backup),
      `Work-Hours-Backup-${dateKey(new Date())}.json`,
      "application/json"
    );
  } catch (error) {
    alert("Backup failed. Please check your storage.");
  }
};

$("restoreBtn").onclick = () => $("restoreFile").click();

$("restoreFile").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;

  if (!confirm("Restore this backup? This replaces existing records and photos.")) {
    event.target.value = "";
    return;
  }

  try {
    const backup = JSON.parse(await file.text());

    if (backup.version !== 1 || !backup.records ||
        !Array.isArray(backup.photos)) {
      throw new Error("Invalid backup file");
    }

    for (const photo of await allPhotos()) {
      await deleteStoredPhoto(photo.id);
    }

    for (const photo of backup.photos) {
      await savePhoto({
        id: photo.id,
        date: photo.date,
        created: photo.created,
        blob: base64ToBlob(photo.data, photo.type)
      });
    }

    records = backup.records;
    saveData();
    await renderDaily();
    await renderWeekly();
    await renderHistory();

    alert("Backup restored successfully.");
  } catch (error) {
    alert("Unable to restore this backup. Please check the file.");
  }

  event.target.value = "";
};

// RESET

$("resetBtn").onclick = async () => {
  if (!confirm("Permanently delete ALL hours, notes and photos? Make a backup first if needed.")) return;

  localStorage.removeItem("workHoursRecords");

  for (const photo of await allPhotos()) {
    await deleteStoredPhoto(photo.id);
  }

  records = {};
  selectedDate = dateKey(new Date());
  currentMonth = new Date();

  $("settingsPanel").classList.add("hidden");
  renderDaily();
  renderWeekly();
  renderHistory();
};

// PWA SERVICE WORKER

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .then(() => console.log("Offline support ready"))
      .catch(error => console.error("Service worker error:", error));
  });
}

// START APP


async function startApp() {
  try {
    // Load previously saved work records
    const savedRecords = localStorage.getItem("workHoursRecords");

    if (savedRecords) {
      try {
        records = JSON.parse(savedRecords);

        if (!records || typeof records !== "object" ||
            Array.isArray(records)) {
          records = {};
        }
      } catch (error) {
  console.error("Could not load saved records:", error);
  alert(
    "Could not read saved work records. " +
    "Your existing saved data has not intentionally been overwritten. " +
    "Please export or recover a backup before continuing."
  );

  throw error;
}
    }

    // Open local photo database
    await openDatabase();

    // Diagnose and request persistent storage.
if (navigator.storage) {
  try {
    const alreadyPersistent =
      await navigator.storage.persisted();

    const persistent =
      alreadyPersistent ||
      (await navigator.storage.persist());

    const estimate =
      await navigator.storage.estimate();

    console.log("Storage diagnostics:", {
      origin: location.origin,
      url: location.href,
      standalone: window.matchMedia(
        "(display-mode: standalone)"
      ).matches,
      persistent,
      localStorageAvailable:
        typeof localStorage !== "undefined",
      savedRecords:
        localStorage.getItem("workHoursRecords") !== null,
      alert(
  "Storage check\n" +
  "Origin: " + location.origin + "\n" +
  "Saved records found: " + (savedRecords !== null) + "\n" +
  "Saved data length: " + (savedRecords ? savedRecords.length : 0) + "\n" +
  "Saved data preview: " + (savedRecords ? savedRecords.substring(0, 150) : "EMPTY")
);
      console.log("WORK RECORDS AT STARTUP:", {
  origin: location.origin,
  url: location.href,
  found: savedRecords !== null,
  length: savedRecords ? savedRecords.length : 0,
  preview: savedRecords ? savedRecords.slice(0, 200) : null
});
      indexedDBAvailable:
        typeof indexedDB !== "undefined",
      storageUsage: estimate.usage,
      storageQuota: estimate.quota
    });

  } catch (error) {
    console.error("Storage diagnostics failed:", error);
  }
}

    // Restore selected accent colour
    const savedAccent = localStorage.getItem("workHoursAccent");

    if (savedAccent) {
      $("accentSelect").value = savedAccent;
      document.documentElement.style.setProperty(
        "--accent",
        savedAccent
      );
    }

    // Render saved information
    renderDaily();
    renderWeekly();
    renderHistory();

    saveStatus("Saved data loaded successfully");

  } catch (error) {
    console.error("App startup error:", error);
    alert("Unable to load the app's saved data.");
  }
}

startApp();

