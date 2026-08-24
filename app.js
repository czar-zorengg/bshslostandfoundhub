/* ============================================================
   BSHS LOST AND FOUND HUB — shared app logic
   Loaded on every page, after supabase.js.
   ============================================================ */

const CATEGORIES = [
  "Bags", "Wallet", "Electronics", "Mobile Phone", "School Supplies",
  "Clothing", "ID/Card", "Keys", "Accessories", "Other"
];

const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/* ---------- small utilities ---------- */

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(d) {
  if (!d) return "—";
  const dt = new Date(String(d).length === 10 ? d + "T00:00:00" : d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function statusClass(status) {
  const map = {
    Pending: "badge badge-pending",
    Approved: "badge badge-approved",
    Rejected: "badge badge-rejected",
    Claimed: "badge badge-claimed",
    Resolved: "badge badge-resolved",
    Completed: "badge badge-claimed"
  };
  return map[status] || "badge";
}

function showMessage(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = "form-message " + (type === "error" ? "form-error" : "form-success");
  el.style.display = "block";
}

function populateCategorySelect(select) {
  if (!select) return;
  select.innerHTML = CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}

/* ---------- auth / session helpers ---------- */

async function getSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    console.error("SUPABASE SESSION ERROR:", error);
    return null;
  }
  return data.session;
}

async function getProfile(userId) {
  const { data, error } = await supabaseClient
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("SUPABASE PROFILE ERROR:", error);
    return null;
  }
  return data;
}

// Reads a one-time "pending profile" (full name + student id) that
// student-register.html stores locally when email confirmation delays
// the Supabase Auth session. This is temporary device state only —
// the permanent record always lives in the Supabase "users" table.
function readPendingProfile(email) {
  try {
    const raw = localStorage.getItem("bshs_pending_profile");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.email === email) return parsed;
    return null;
  } catch {
    return null;
  }
}

function clearPendingProfile() {
  localStorage.removeItem("bshs_pending_profile");
}

// Makes sure a public.users profile row exists for a logged-in auth user.
async function ensureProfile(user) {
  if (!user) return null;
  let profile = await getProfile(user.id);
  if (profile) return profile;

  const pending = readPendingProfile(user.email);

  const row = {
    id: user.id,
    email: user.email,
    full_name: (pending && pending.full_name) || user.email,
    student_id: (pending && pending.student_id) || null,
    role: "student"
  };

  const { error } = await supabaseClient
    .from("users")
    .upsert([row], { onConflict: "id", ignoreDuplicates: true });
  if (error) {
    console.error("SUPABASE ENSURE PROFILE ERROR:", error);
    return null;
  }
  clearPendingProfile();
  return await getProfile(user.id);
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = "index.html";
}

/* ---------- navigation ---------- */

async function renderNav(activePage) {
  const container = document.getElementById("nav-container");
  if (!container) return;

  const session = await getSession();
  const loggedIn = !!session;

  const links = [
    { href: "index.html", label: "Home" },
    { href: "items.html", label: "Items" },
    { href: "my-reports.html", label: "My Reports" },
    { href: "claim-requests.html", label: "My Claim Requests" }
  ];

  let linksHtml = links.map(l =>
    `<a href="${l.href}" class="${activePage === l.href ? "active" : ""}">${l.label}</a>`
  ).join("");

  linksHtml += loggedIn
    ? `<a href="#" id="logout-link">Logout</a>`
    : `<a href="students-login.html" class="${activePage === "students-login.html" ? "active" : ""}">Login</a>`;

  container.innerHTML = `
    <div class="nav-inner">
      <a class="brand" href="index.html">BSHS LOST AND FOUND HUB</a>
      <button class="nav-toggle" id="nav-toggle" aria-label="Toggle navigation">&#9776;</button>
      <nav class="nav-links" id="nav-links">${linksHtml}</nav>
    </div>
  `;

  document.getElementById("nav-toggle")?.addEventListener("click", () => {
    document.getElementById("nav-links")?.classList.toggle("open");
  });

  document.getElementById("logout-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    logout();
  });
}

/* ---------- page guards ---------- */

async function requireStudentLogin() {
  const session = await getSession();
  if (!session) {
    window.location.href = "students-login.html";
    return null;
  }
  const profile = await ensureProfile(session.user);
  return { session, profile };
}

async function requireAdminLogin() {
  const session = await getSession();
  if (!session) {
    window.location.href = "admin-login.html";
    return null;
  }
  const profile = await getProfile(session.user.id);
  if (!profile || profile.role !== "admin") {
    alert("This account does not have admin access.");
    window.location.href = "admin-login.html";
    return null;
  }
  return { session, profile };
}

/* ---------- photo upload ---------- */

function validatePhoto(file) {
  if (!file) return { ok: true };
  if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
    return { ok: false, error: "Photo must be a JPEG, PNG, or WebP image." };
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: "Photo must be smaller than 1.5 MB." };
  }
  return { ok: true };
}

async function uploadPhoto(file, ownerId) {
  const folder = ownerId || "guest";
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from("report-photos")
    .upload(path, file, { cacheControl: "3600", upsert: false });

  if (uploadError) {
    console.error("SUPABASE STORAGE ERROR:", uploadError);
    throw new Error("Photo upload failed: " + uploadError.message);
  }

  const { data } = supabaseClient.storage.from("report-photos").getPublicUrl(path);
  return data.publicUrl;
}
