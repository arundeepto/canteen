import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, onSnapshot, collection, query, where, orderBy, limit,
  getDocs, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  MEAL_CONFIG, LOW_BALANCE_THRESHOLD, todayStr, isBeforeDeadline,
  formatDateBn, formatTaka, mealTypeLabel, mealPrice, showToast, mealDocId
} from "./utils.js";

let profile = null;
let uid = null;
const today = todayStr();

// ---------- auth guard ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  uid = user.uid;
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists() || snap.data().role !== "boarder") {
    window.location.href = snap.exists() ? "admin.html" : "index.html";
    return;
  }
  profile = snap.data();
  initUI();
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

function initUI() {
  document.getElementById("loadingScreen").style.display = "none";
  document.getElementById("appShell").style.display = "grid";
  document.getElementById("sideName").textContent = profile.fullName;
  document.getElementById("sideMeta").textContent = `ব্যাচ ${profile.batch} · রোল ${profile.roll} · রুম ${profile.room}`;
  document.getElementById("dateEyebrow").textContent = formatDateBn(today);

  setupNav();
  renderPickers();
  watchUser();
  watchTodayMeals();
  loadLedger();
  loadMealHistory();
  loadSpecials();
}

// ---------- nav ----------
function setupNav() {
  const views = ["home", "ledger", "specials"];
  const titles = { home: "আজকের মিল", ledger: "হিসাব", specials: "স্পেশাল খাবার" };
  function activate(view) {
    views.forEach(v => document.getElementById(`view-${v}`).style.display = v === view ? "block" : "none");
    document.querySelectorAll("#sideNav button, #mobileNav button").forEach(b => {
      b.classList.toggle("active", b.dataset.view === view);
    });
    document.getElementById("viewTitle").textContent = titles[view];
  }
  document.querySelectorAll("#sideNav button, #mobileNav button").forEach(b => {
    b.addEventListener("click", () => activate(b.dataset.view));
  });
}

// ---------- balance ----------
function watchUser() {
  onSnapshot(doc(db, "users", uid), (snap) => {
    const balance = snap.data()?.balance ?? 0;
    const banner = document.getElementById("balanceBanner");
    const isLow = balance <= LOW_BALANCE_THRESHOLD;
    banner.classList.toggle("danger", isLow);
    document.getElementById("balanceAmount").textContent = formatTaka(balance);
    document.getElementById("balanceNote").textContent = isLow
      ? "হিসাব বাকিতে চলে গেছে — ক্যান্টিনে টাকা জমা না দেওয়া পর্যন্ত নতুন মিল অন করা যাবে না।"
      : "";
  });
}

// ---------- meal pickers ----------
function renderPickers() {
  renderPickerFor("lunch");
  renderPickerFor("dinner");
}

function renderPickerFor(period) {
  const wrap = document.getElementById(`${period}Picker`);
  wrap.innerHTML = "";
  Object.entries(MEAL_CONFIG[period].options).forEach(([type, cfg]) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "meal-opt";
    opt.dataset.type = type;
    opt.innerHTML = `<div class="name">${cfg.label}</div><div class="price">৳${cfg.price}</div>`;
    opt.addEventListener("click", () => toggleMeal(period, type));
    wrap.appendChild(opt);
  });
}

let currentMeals = { lunch: null, dinner: null };

function watchTodayMeals() {
  ["lunch", "dinner"].forEach(period => {
    const ref = doc(db, "meals", mealDocId(today, uid, period));
    onSnapshot(ref, (snap) => {
      currentMeals[period] = snap.exists() ? snap.data() : null;
      renderMealState(period);
      renderTokens();
    });
  });
}

function renderMealState(period) {
  const meal = currentMeals[period];
  const wrap = document.getElementById(`${period}Picker`);
  const chip = document.getElementById(`${period}StatusChip`);
  const locked = !isBeforeDeadline();

  wrap.querySelectorAll(".meal-opt").forEach(opt => {
    const isSelected = meal && meal.status === "on" && meal.mealType === opt.dataset.type;
    opt.classList.toggle("selected", isSelected);
    opt.disabled = locked;
  });

  if (meal && meal.status === "cancelled") {
    chip.className = "chip cancelled";
    chip.textContent = "এডমিন বাতিল করেছে";
  } else if (meal && meal.status === "on") {
    chip.className = `chip ${meal.mealType}`;
    chip.textContent = "চালু আছে";
  } else if (locked) {
    chip.className = "chip off";
    chip.textContent = "সময় শেষ · অফ";
  } else {
    chip.className = "chip off";
    chip.textContent = "বন্ধ";
  }
}

async function toggleMeal(period, type) {
  if (!isBeforeDeadline()) {
    showToast("সকাল ১০টা পার হয়ে গেছে, এখন পরিবর্তন করা যাবে না", true);
    return;
  }
  const mealRef = doc(db, "meals", mealDocId(today, uid, period));
  const userRef = doc(db, "users", uid);
  const price = mealPrice(period, type);

  try {
    await runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      const mealSnap = await tx.get(mealRef);
      const balance = userSnap.data().balance || 0;
      const existing = mealSnap.exists() ? mealSnap.data() : null;

      if (existing && existing.status === "on" && existing.mealType === type) {
        // same option clicked again -> turn off & refund
        const newBalance = balance + existing.price;
        tx.update(userRef, { balance: newBalance });
        tx.set(mealRef, { ...existing, status: "off", price: 0, updatedAt: serverTimestamp() });
        const txnRef = doc(collection(db, "transactions"));
        tx.set(txnRef, {
          uid, type: "meal_refund", amount: existing.price, date: today,
          note: `${MEAL_CONFIG[period].label} বন্ধ করা হয়েছে`, balanceAfter: newBalance,
          createdAt: serverTimestamp()
        });
        return;
      }

      const oldPrice = existing && existing.status === "on" ? existing.price : 0;
      const diff = price - oldPrice;
      if (diff > 0 && balance <= LOW_BALANCE_THRESHOLD) {
        throw new Error("LOW_BALANCE");
      }
      const newBalance = balance - diff;
      tx.set(mealRef, {
        uid, batch: profile.batch, roll: profile.roll, fullName: profile.fullName, room: profile.room,
        date: today, mealPeriod: period, mealType: type, price,
        status: "on", checked: existing?.checked || false, isGuest: false,
        createdAt: existing?.createdAt || serverTimestamp(), updatedAt: serverTimestamp()
      });
      tx.update(userRef, { balance: newBalance });
      const txnRef = doc(collection(db, "transactions"));
      tx.set(txnRef, {
        uid, type: "meal_deduction", amount: -diff, date: today,
        note: `${MEAL_CONFIG[period].label} - ${mealTypeLabel(period, type)}`, balanceAfter: newBalance,
        createdAt: serverTimestamp()
      });
    });
  } catch (err) {
    if (err.message === "LOW_BALANCE") {
      showToast("হিসাবে বাকি আছে — টাকা জমা না দেওয়া পর্যন্ত মিল অন করা যাবে না", true);
    } else {
      showToast("সমস্যা হয়েছে, আবার চেষ্টা করুন", true);
    }
  }
}

// ---------- tokens ----------
function renderTokens() {
  const wrap = document.getElementById("tokenWrap");
  wrap.innerHTML = "";
  let any = false;
  ["lunch", "dinner"].forEach(period => {
    const meal = currentMeals[period];
    if (meal && meal.status === "on") {
      any = true;
      const el = document.createElement("div");
      el.className = `token ${meal.mealType}`;
      el.innerHTML = `
        <div class="stub">${period === "lunch" ? "LUNCH" : "DINNER"}</div>
        <div class="body">
          <div class="kind">${MEAL_CONFIG[period].label} · ${mealTypeLabel(period, meal.mealType)}</div>
          <div class="meta">
            <span>${formatDateBn(today)}</span>
            <span>রোল ${profile.roll}</span>
            <span>${meal.checked ? "টোকেন গ্রহণ করা হয়েছে" : "একটিভ"}</span>
          </div>
        </div>`;
      wrap.appendChild(el);
    }
  });
  if (!any) {
    const el = document.createElement("div");
    el.className = "token empty";
    el.textContent = "আজ কোনো মিল অন নেই";
    wrap.appendChild(el);
  }
}

// ---------- ledger ----------
async function loadLedger() {
  const q = query(collection(db, "transactions"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(80));
  const snap = await getDocs(q);
  const body = document.getElementById("ledgerBody");
  body.innerHTML = "";
  if (snap.empty) { document.getElementById("ledgerEmpty").style.display = "block"; return; }
  snap.forEach(d => {
    const t = d.data();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateBn(t.date)}</td>
      <td>${t.note || t.type}</td>
      <td class="num" style="color:${t.amount < 0 ? 'var(--rust-deep)' : 'var(--teal-deep)'}">${t.amount < 0 ? '' : '+'}${formatTaka(t.amount)}</td>
      <td class="num">${formatTaka(t.balanceAfter ?? 0)}</td>`;
    body.appendChild(tr);
  });
}

// ---------- meal history ----------
async function loadMealHistory() {
  const q = query(collection(db, "meals"), where("uid", "==", uid), orderBy("date", "desc"), limit(60));
  const snap = await getDocs(q);
  const body = document.getElementById("mealHistoryBody");
  body.innerHTML = "";
  if (snap.empty) { document.getElementById("mealHistoryEmpty").style.display = "block"; return; }
  snap.forEach(d => {
    const m = d.data();
    const tr = document.createElement("tr");
    const statusLabel = m.status === "cancelled" ? "বাতিল" : m.status === "on" ? (m.checked ? "সম্পন্ন" : "চালু") : "বন্ধ";
    tr.innerHTML = `
      <td>${formatDateBn(m.date)}</td>
      <td>${MEAL_CONFIG[m.mealPeriod]?.label || m.mealPeriod}</td>
      <td><span class="chip ${m.status === 'cancelled' ? 'cancelled' : m.mealType}">${mealTypeLabel(m.mealPeriod, m.mealType)}</span></td>
      <td class="num">${formatTaka(m.status === 'cancelled' ? 0 : m.price)}</td>
      <td>${statusLabel}</td>`;
    body.appendChild(tr);
  });
}

// ---------- specials ----------
async function loadSpecials() {
  const q = query(collection(db, "specials"), where("date", "==", today), where("active", "==", true));
  const snap = await getDocs(q);
  const wrap = document.getElementById("specialsWrap");
  wrap.innerHTML = "";
  if (snap.empty) { document.getElementById("specialsEmpty").style.display = "block"; return; }
  snap.forEach(d => {
    const s = d.data();
    const el = document.createElement("div");
    el.className = "card";
    el.style.margin = "0";
    el.innerHTML = `<div class="card-head"><h3>${s.name}</h3><span class="chip full">৳${s.price}</span></div>
      <p class="muted">ক্যান্টিনে সরাসরি জানিয়ে নিতে পারবে। এডমিন হিসাব থেকে মূল্য কেটে নেবেন।</p>`;
    wrap.appendChild(el);
  });
}
