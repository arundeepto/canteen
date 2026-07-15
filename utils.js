// ==========================================================================
// শেয়ার্ড কনস্ট্যান্ট ও হেল্পার ফাংশন
// ==========================================================================

export const BATCHES = [3, 4, 5, 6, 7, 8];

export const MEAL_CONFIG = {
  lunch: {
    label: "দুপুরের খাবার",
    options: {
      full:  { label: "ফুল মিল",  price: 70 },
      half:  { label: "হাফ মিল",  price: 50 }
    }
  },
  dinner: {
    label: "রাতের খাবার",
    options: {
      full:    { label: "ফুল মিল",     price: 70 },
      half:    { label: "হাফ মিল",     price: 50 },
      quarter: { label: "কোয়ার্টার মিল", price: 30 }
    }
  }
};

export const MEAL_ON_DEADLINE_HOUR = 10; // সকাল ১০টা
export const LOW_BALANCE_THRESHOLD = -200; // এই মান বা এর নিচে গেলে ড্যাশবোর্ড লাল হবে

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isBeforeDeadline(d = new Date()) {
  return d.getHours() < MEAL_ON_DEADLINE_HOUR;
}

export function formatDateBn(dateStr) {
  const months = ["জানু", "ফেব্রু", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্ট", "অক্টো", "নভে", "ডিসে"];
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

export function formatTaka(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}৳${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function mealTypeLabel(period, type) {
  return MEAL_CONFIG[period]?.options[type]?.label || type;
}

export function mealPrice(period, type) {
  return MEAL_CONFIG[period]?.options[type]?.price ?? 0;
}

let toastTimer = null;
export function showToast(msg, isError = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

export function mealDocId(dateStr, uid, period) {
  return `${dateStr}_${uid}_${period}`;
}
