import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, collection, query, where,
  updateDoc, addDoc, increment, serverTimestamp, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  BATCHES, MEAL_CONFIG, LOW_BALANCE_THRESHOLD, todayStr, isBeforeDeadline,
  formatDateBn, formatTaka, mealTypeLabel, showToast
} from "./utils.js";

let adminProfile = null;
let allBoarders = []; // {id, fullName, batch, roll, room, balance}
const today = todayStr();
let reportDate = today;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists() || snap.data().role !== "admin") {
    window.location.href = snap.exists() ? "boarder.html" : "index.html";
    return;
  }
  adminProfile = snap.data();
  await initUI();
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

async function initUI() {
  document.getElementById("loadingScreen").style.display = "none";
  document.getElementById("appShell").style.display = "grid";
  document.getElementById("sideName").textContent = adminProfile.fullName || "এডমিন";
  document.getElementById("dateEyebrow").textContent = formatDateBn(today);
  document.getElementById("reportDate").value = today;

  setupNav();
  await loadAllBoarders();
  await renderToday();
  renderAccounts();
  await renderSpecialsTab();
  await renderReport(today);

  document.getElementById("addGuestBtn").addEventListener("click", openGuestModal);
  document.getElementById("depositSearch").addEventListener("input", renderDepositResults);
  document.getElementById("depositConfirmBtn").addEventListener("click", confirmDeposit);
  document.getElementById("accountsSearch").addEventListener("input", renderAccounts);
  document.getElementById("addSpecialBtn").addEventListener("click", addSpecial);
  document.getElementById("reportDate").addEventListener("change", (e) => renderReport(e.target.value));
  document.getElementById("downloadPdfBtn").addEventListener("click", downloadPdf);
}

// ---------- nav ----------
function setupNav() {
  const views = ["today", "deposit", "accounts", "specials", "reports"];
  const titles = { today: "আজকের মিল", deposit: "টাকা জমা", accounts: "বোর্ডারদের হিসাব", specials: "স্পেশাল খাবার", reports: "রিপোর্ট" };
  function activate(view) {
    views.forEach(v => document.getElementById(`view-${v}`).style.display = v === view ? "block" : "none");
    document.querySelectorAll("#sideNav button, #mobileNav button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("viewTitle").textContent = titles[view];
  }
  document.querySelectorAll("#sideNav button, #mobileNav button").forEach(b => b.addEventListener("click", () => activate(b.dataset.view)));
}

// ---------- shared: boarder directory ----------
async function loadAllBoarders() {
  const q = query(collection(db, "users"), where("role", "==", "boarder"));
  const snap = await getDocs(q);
  allBoarders = [];
  snap.forEach(d => allBoarders.push({ id: d.id, ...d.data() }));
  allBoarders.sort((a, b) => (a.batch - b.batch) || (a.roll || "").localeCompare(b.roll || ""));
}

// ---------- generic modal ----------
function openModal(titleHTML, bodyHTML) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "modalOverlay";
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="card-head"><h2>${titleHTML}</h2><button class="modal-close" id="modalCloseBtn">&times;</button></div>
      <div id="modalBody">${bodyHTML}</div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
}
function closeModal() {
  const el = document.getElementById("modalOverlay");
  if (el) el.remove();
}

// ==========================================================================
// TODAY VIEW
// ==========================================================================
let todayMeals = []; // all meal docs for today (boarders + guests)

async function loadTodayMeals() {
  const q = query(collection(db, "meals"), where("date", "==", today));
  const snap = await getDocs(q);
  todayMeals = [];
  snap.forEach(d => todayMeals.push({ id: d.id, ...d.data() }));
}

async function renderToday() {
  await loadTodayMeals();

  const active = todayMeals.filter(m => m.status === "on");
  const totalCollection = active.reduce((s, m) => s + (m.price || 0), 0);
  const lunchCount = active.filter(m => m.mealPeriod === "lunch").length;
  const dinnerCount = active.filter(m => m.mealPeriod === "dinner").length;
  const checkedCount = active.filter(m => m.checked).length;

  document.getElementById("todayStats").innerHTML = `
    <div class="stat"><div class="label">মোট মিল চালু</div><div class="value">${active.length}</div></div>
    <div class="stat"><div class="label">দুপুর</div><div class="value gold">${lunchCount}</div></div>
    <div class="stat"><div class="label">রাত</div><div class="value teal">${dinnerCount}</div></div>
    <div class="stat"><div class="label">আজকের কালেকশন</div><div class="value rust">${formatTaka(totalCollection)}</div></div>
  `;

  renderGuestTable();
  renderBatchSections();
}

function renderGuestTable() {
  const guests = todayMeals.filter(m => m.isGuest);
  const body = document.getElementById("guestBody");
  body.innerHTML = "";
  document.getElementById("guestEmpty").style.display = guests.length ? "none" : "block";
  guests.forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.guestName || "গেস্ট"}</td>
      <td>${MEAL_CONFIG[m.mealPeriod]?.label}</td>
      <td><span class="chip ${m.status === 'cancelled' ? 'cancelled' : m.mealType}">${mealTypeLabel(m.mealPeriod, m.mealType)}</span></td>
      <td class="num">${formatTaka(m.status === 'cancelled' ? 0 : m.price)}</td>
      <td><label class="checkbox-row"><input type="checkbox" ${m.checked ? "checked" : ""} data-meal-id="${m.id}" class="guestCheckbox"></label></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll(".guestCheckbox").forEach(cb => {
    cb.addEventListener("change", (e) => toggleChecked(e.target.dataset.mealId, e.target.checked));
  });
}

function renderBatchSections() {
  const wrap = document.getElementById("batchSections");
  wrap.innerHTML = "";
  BATCHES.forEach(batch => {
    const boardersInBatch = allBoarders.filter(b => b.batch === batch);
    if (!boardersInBatch.length) return;

    const section = document.createElement("div");
    section.className = "card batch-section";
    let rows = "";
    boardersInBatch.forEach(b => {
      const lunch = todayMeals.find(m => m.uid === b.id && m.mealPeriod === "lunch" && !m.isGuest);
      const dinner = todayMeals.find(m => m.uid === b.id && m.mealPeriod === "dinner" && !m.isGuest);
      if (!lunch && !dinner) return; // only show boarders who turned something on
      rows += `<tr>
        <td>${b.fullName}<div class="muted" style="font-size:.78rem;">রোল ${b.roll} · রুম ${b.room}</div></td>
        ${renderMealCell(lunch)}
        ${renderMealCell(dinner)}
      </tr>`;
    });

    if (!rows) return;
    section.innerHTML = `
      <div class="batch-title"><span class="badge">ব্যাচ ${batch}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>নাম</th><th>দুপুর</th><th>রাত</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    wrap.appendChild(section);

    section.querySelectorAll(".mealCheckbox").forEach(cb => {
      cb.addEventListener("change", (e) => toggleChecked(e.target.dataset.mealId, e.target.checked));
    });
    section.querySelectorAll(".cancelMealBtn").forEach(btn => {
      btn.addEventListener("click", (e) => cancelMeal(e.target.dataset.mealId, e.target.dataset.uid));
    });
  });

  if (!wrap.children.length) {
    wrap.innerHTML = `<div class="card"><div class="empty-state">আজ এখনো কেউ মিল অন করেনি</div></div>`;
  }
}

function renderMealCell(meal) {
  if (!meal) return `<td><span class="chip off">বন্ধ</span></td>`;
  if (meal.status === "cancelled") return `<td><span class="chip cancelled">বাতিল</span></td>`;
  return `<td>
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <span class="chip ${meal.mealType}">${mealTypeLabel(meal.mealPeriod, meal.mealType)}</span>
      <label class="checkbox-row"><input type="checkbox" ${meal.checked ? "checked" : ""} data-meal-id="${meal.id}" class="mealCheckbox"></label>
      <button class="btn btn-ghost btn-sm cancelMealBtn" data-meal-id="${meal.id}" data-uid="${meal.uid}">বাতিল</button>
    </div>
  </td>`;
}

async function toggleChecked(mealId, checked) {
  try {
    await updateDoc(doc(db, "meals", mealId), { checked });
  } catch {
    showToast("আপডেট করা যায়নি", true);
  }
}

async function cancelMeal(mealId, uid) {
  if (!confirm("এই মিলটি বাতিল করতে চান? বোর্ডারের হিসাবে টাকা ফেরত যাবে।")) return;
  try {
    await runTransaction(db, async (tx) => {
      const mealRef = doc(db, "meals", mealId);
      const mealSnap = await tx.get(mealRef);
      if (!mealSnap.exists() || mealSnap.data().status !== "on") return;
      const m = mealSnap.data();
      tx.update(mealRef, { status: "cancelled", updatedAt: serverTimestamp() });
      if (!m.isGuest) {
        const userRef = doc(db, "users", uid);
        tx.update(userRef, { balance: increment(m.price) });
        const txnRef = doc(collection(db, "transactions"));
        tx.set(txnRef, {
          uid, type: "meal_refund", amount: m.price, date: today,
          note: `${MEAL_CONFIG[m.mealPeriod]?.label || m.mealPeriod} এডমিন বাতিল করেছেন`,
          createdAt: serverTimestamp()
        });
      }
    });
    showToast("মিল বাতিল করা হয়েছে");
    await renderToday();
    renderAccounts();
  } catch {
    showToast("বাতিল করা যায়নি", true);
  }
}

// ---------- guest meal modal ----------
function openGuestModal() {
  const periodOptions = Object.entries(MEAL_CONFIG).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  openModal("গেস্ট মিল যোগ করুন", `
    <div class="field"><label>নাম (ঐচ্ছিক)</label><input type="text" id="guestName"></div>
    <div class="field"><label>বেলা</label><select id="guestPeriod">${periodOptions}</select></div>
    <div class="field"><label>ধরন</label><select id="guestType"></select></div>
    <button class="btn btn-primary btn-block" id="guestSaveBtn">যোগ করুন</button>
  `);
  const periodSel = document.getElementById("guestPeriod");
  const typeSel = document.getElementById("guestType");
  function fillTypes() {
    const opts = MEAL_CONFIG[periodSel.value].options;
    typeSel.innerHTML = Object.entries(opts).map(([k, v]) => `<option value="${k}">${v.label} — ৳${v.price}</option>`).join("");
  }
  fillTypes();
  periodSel.addEventListener("change", fillTypes);
  document.getElementById("guestSaveBtn").addEventListener("click", async () => {
    const name = document.getElementById("guestName").value.trim() || "গেস্ট";
    const period = periodSel.value;
    const type = typeSel.value;
    const price = MEAL_CONFIG[period].options[type].price;
    try {
      await addDoc(collection(db, "meals"), {
        uid: null, isGuest: true, guestName: name,
        date: today, mealPeriod: period, mealType: type, price,
        status: "on", checked: false, createdAt: serverTimestamp()
      });
      showToast("গেস্ট মিল যোগ করা হয়েছে");
      closeModal();
      await renderToday();
    } catch {
      showToast("যোগ করা যায়নি", true);
    }
  });
}

// ==========================================================================
// DEPOSIT VIEW
// ==========================================================================
let selectedBoarderId = null;

function renderDepositResults() {
  const term = document.getElementById("depositSearch").value.trim().toLowerCase();
  const wrap = document.getElementById("depositResults");
  wrap.innerHTML = "";
  if (!term) return;
  const matches = allBoarders.filter(b =>
    b.fullName.toLowerCase().includes(term) || String(b.roll).toLowerCase().includes(term)
  ).slice(0, 6);
  matches.forEach(b => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "btn btn-ghost btn-sm";
    row.style.justifyContent = "flex-start";
    row.textContent = `${b.fullName} — ব্যাচ ${b.batch}, রোল ${b.roll}`;
    row.addEventListener("click", () => selectDepositBoarder(b.id));
    wrap.appendChild(row);
  });
}

function selectDepositBoarder(id) {
  selectedBoarderId = id;
  const b = allBoarders.find(x => x.id === id);
  document.getElementById("depositResults").innerHTML = "";
  document.getElementById("depositSearch").value = "";
  document.getElementById("depositSelected").style.display = "block";
  document.getElementById("depositSelectedName").textContent = b.fullName;
  document.getElementById("depositSelectedMeta").textContent = `ব্যাচ ${b.batch} · রোল ${b.roll} · রুম ${b.room}`;
  document.getElementById("depositSelectedBalance").textContent = formatTaka(b.balance || 0);
}

async function confirmDeposit() {
  const amount = Number(document.getElementById("depositAmount").value);
  if (!selectedBoarderId || !amount || amount <= 0) {
    showToast("সঠিক পরিমাণ দিন", true);
    return;
  }
  try {
    const userRef = doc(db, "users", selectedBoarderId);
    await updateDoc(userRef, { balance: increment(amount) });
    await addDoc(collection(db, "transactions"), {
      uid: selectedBoarderId, type: "deposit", amount, date: today,
      note: "ক্যান্টিনে টাকা জমা", createdAt: serverTimestamp()
    });
    showToast("জমা সম্পন্ন হয়েছে");
    document.getElementById("depositAmount").value = "";
    document.getElementById("depositSelected").style.display = "none";
    await loadAllBoarders();
    renderAccounts();
  } catch {
    showToast("জমা ব্যর্থ হয়েছে", true);
  }
}

// ==========================================================================
// ACCOUNTS VIEW
// ==========================================================================
function renderAccounts() {
  const term = (document.getElementById("accountsSearch").value || "").trim().toLowerCase();
  const body = document.getElementById("accountsBody");
  body.innerHTML = "";
  allBoarders
    .filter(b => !term || b.fullName.toLowerCase().includes(term) || String(b.roll).toLowerCase().includes(term))
    .forEach(b => {
      const isLow = (b.balance || 0) <= LOW_BALANCE_THRESHOLD;
      const tr = document.createElement("tr");
      if (isLow) tr.style.background = "rgba(193,80,46,.08)";
      tr.innerHTML = `
        <td>${b.fullName}</td>
        <td>${b.batch}</td>
        <td>${b.roll}</td>
        <td>${b.room}</td>
        <td class="num" style="color:${isLow ? 'var(--rust-deep)' : 'var(--ink)'}; font-family:var(--font-mono); font-weight:600;">${formatTaka(b.balance || 0)}</td>`;
      body.appendChild(tr);
    });
}

// ==========================================================================
// SPECIALS VIEW
// ==========================================================================
async function renderSpecialsTab() {
  const q = query(collection(db, "specials"), where("date", "==", today));
  const snap = await getDocs(q);
  const listWrap = document.getElementById("specialsList");
  listWrap.innerHTML = "";
  document.getElementById("specialsListEmpty").style.display = snap.empty ? "block" : "none";

  snap.forEach(d => {
    const s = { id: d.id, ...d.data() };
    const card = document.createElement("div");
    card.className = "card";
    card.style.margin = "0";
    const orderedUids = s.orderedUids || [];
    const groups = BATCHES.map(batch => {
      const inBatch = allBoarders.filter(b => b.batch === batch);
      if (!inBatch.length) return "";
      const rows = inBatch.map(b => `
        <div class="boarder-check">
          <span>${b.fullName} <span class="muted">(রোল ${b.roll})</span></span>
          <input type="checkbox" data-uid="${b.id}" class="specialCheckbox" ${orderedUids.includes(b.id) ? "checked" : ""}>
        </div>`).join("");
      return `<div class="batch-check-group"><div class="batch-title"><span class="badge">ব্যাচ ${batch}</span></div>${rows}</div>`;
    }).join("");

    card.innerHTML = `
      <div class="card-head"><h3>${s.name}</h3><span class="chip full">৳${s.price}</span></div>
      <div class="special-groups" data-special-id="${s.id}" data-price="${s.price}">${groups}</div>
      <button class="btn btn-teal btn-sm saveSpecialBtn" data-special-id="${s.id}" style="margin-top:14px;">নির্বাচন সংরক্ষণ করুন</button>
    `;
    listWrap.appendChild(card);
  });

  listWrap.querySelectorAll(".saveSpecialBtn").forEach(btn => {
    btn.addEventListener("click", () => saveSpecialOrders(btn.dataset.specialId));
  });
}

async function addSpecial() {
  const name = document.getElementById("specialName").value.trim();
  const price = Number(document.getElementById("specialPrice").value);
  if (!name || !price || price <= 0) {
    showToast("নাম ও সঠিক মূল্য দিন", true);
    return;
  }
  try {
    await addDoc(collection(db, "specials"), {
      name, price, date: today, active: true, orderedUids: [], createdAt: serverTimestamp()
    });
    document.getElementById("specialName").value = "";
    document.getElementById("specialPrice").value = "";
    showToast("স্পেশাল যোগ করা হয়েছে");
    await renderSpecialsTab();
  } catch {
    showToast("যোগ করা যায়নি", true);
  }
}

async function saveSpecialOrders(specialId) {
  const groupEl = document.querySelector(`.special-groups[data-special-id="${specialId}"]`);
  const price = Number(groupEl.dataset.price);
  const checkboxes = groupEl.querySelectorAll(".specialCheckbox");
  const newlySelected = [];
  const newlyUnselected = [];
  const specialRef = doc(db, "specials", specialId);
  const specialSnap = await getDoc(specialRef);
  const prevUids = specialSnap.data().orderedUids || [];

  checkboxes.forEach(cb => {
    const uid = cb.dataset.uid;
    const wasOrdered = prevUids.includes(uid);
    if (cb.checked && !wasOrdered) newlySelected.push(uid);
    if (!cb.checked && wasOrdered) newlyUnselected.push(uid);
  });

  if (!newlySelected.length && !newlyUnselected.length) {
    showToast("কোনো পরিবর্তন নেই");
    return;
  }

  try {
    const batch = writeBatch(db);
    newlySelected.forEach(uid => {
      batch.update(doc(db, "users", uid), { balance: increment(-price) });
      const txnRef = doc(collection(db, "transactions"));
      batch.set(txnRef, { uid, type: "special_deduction", amount: -price, date: today, note: "স্পেশাল খাবার", createdAt: serverTimestamp() });
    });
    newlyUnselected.forEach(uid => {
      batch.update(doc(db, "users", uid), { balance: increment(price) });
      const txnRef = doc(collection(db, "transactions"));
      batch.set(txnRef, { uid, type: "special_refund", amount: price, date: today, note: "স্পেশাল খাবার বাদ", createdAt: serverTimestamp() });
    });
    const finalUids = [...prevUids.filter(u => !newlyUnselected.includes(u)), ...newlySelected];
    batch.update(specialRef, { orderedUids: finalUids });
    await batch.commit();
    showToast("সংরক্ষণ করা হয়েছে");
    await loadAllBoarders();
    renderAccounts();
  } catch {
    showToast("সংরক্ষণ ব্যর্থ হয়েছে", true);
  }
}

// ==========================================================================
// REPORTS VIEW
// ==========================================================================
let reportMeals = [];

async function renderReport(dateStr) {
  reportDate = dateStr;
  const q = query(collection(db, "meals"), where("date", "==", dateStr));
  const snap = await getDocs(q);
  reportMeals = [];
  snap.forEach(d => reportMeals.push({ id: d.id, ...d.data() }));

  const active = reportMeals.filter(m => m.status === "on");
  const total = active.reduce((s, m) => s + (m.price || 0), 0);
  const lunch = active.filter(m => m.mealPeriod === "lunch").length;
  const dinner = active.filter(m => m.mealPeriod === "dinner").length;

  document.getElementById("reportStats").innerHTML = `
    <div class="stat"><div class="label">মোট মিল</div><div class="value">${active.length}</div></div>
    <div class="stat"><div class="label">দুপুর</div><div class="value gold">${lunch}</div></div>
    <div class="stat"><div class="label">রাত</div><div class="value teal">${dinner}</div></div>
    <div class="stat"><div class="label">মোট কালেকশন</div><div class="value rust">${formatTaka(total)}</div></div>
  `;

  const body = document.getElementById("reportBody");
  body.innerHTML = "";
  active.sort((a, b) => (a.batch || 0) - (b.batch || 0));
  active.forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.isGuest ? (m.guestName || "গেস্ট") : m.fullName}</td>
      <td>${m.isGuest ? "—" : m.batch}</td>
      <td>${m.isGuest ? "—" : m.roll}</td>
      <td>${MEAL_CONFIG[m.mealPeriod]?.label}</td>
      <td><span class="chip ${m.mealType}">${mealTypeLabel(m.mealPeriod, m.mealType)}</span></td>
      <td class="num">${formatTaka(m.price)}</td>`;
    body.appendChild(tr);
  });

  const btn = document.getElementById("downloadPdfBtn");
  const locked = dateStr === today && isBeforeDeadline();
  btn.disabled = locked;
  btn.textContent = locked ? "সকাল ১০টার পর সম্ভব" : "PDF ডাউনলোড";
}

function downloadPdf() {
  const { jsPDF } = window.jspdf;
  const docPdf = new jsPDF();
  const active = reportMeals.filter(m => m.status === "on");
  const total = active.reduce((s, m) => s + (m.price || 0), 0);

  docPdf.setFontSize(16);
  docPdf.text("Korotoa Chatrabas - Daily Meal Report", 14, 18);
  docPdf.setFontSize(11);
  docPdf.text(`Date: ${reportDate}`, 14, 26);
  docPdf.text(`Total Meals: ${active.length}   Total Collection: Tk ${total}`, 14, 33);

  const rows = active
    .sort((a, b) => (a.batch || 0) - (b.batch || 0))
    .map(m => [
      m.isGuest ? (m.guestName || "Guest") : m.fullName,
      m.isGuest ? "-" : String(m.batch),
      m.isGuest ? "-" : m.roll,
      m.mealPeriod,
      m.mealType,
      String(m.price)
    ]);

  docPdf.autoTable({
    startY: 40,
    head: [["Name", "Batch", "Roll", "Period", "Type", "Price"]],
    body: rows,
    styles: { fontSize: 9 }
  });

  docPdf.save(`korotoa-meal-report-${reportDate}.pdf`);
}
