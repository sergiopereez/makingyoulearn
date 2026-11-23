// Making You Learn Publisher: posts a video to the signed-in TikTok account through
// the Content Posting API (Direct Post). The backend (Supabase Edge Function) keeps the
// client secret and forwards calls, because TikTok's API cannot be called from a browser.
const FN = "https://cdfbruygwxgdwravthrz.supabase.co/functions/v1/tiktok-publisher";
const $ = (id) => document.getElementById(id);
const PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};
let token = sessionStorage.getItem("tt_token") || "";
let creator = null;
let videoSeconds = 0;

async function call(action, body, headers = {}) {
  const r = await fetch(`${FN}?action=${action}`, {
    method: "POST",
    headers: { "x-tt-token": token, ...(body instanceof Blob ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body instanceof Blob ? body : JSON.stringify(body || {}),
  });
  return r.json();
}
const log = (msg) => { $("progress").classList.remove("hidden"); $("log").textContent += msg + "\n"; };

// ---------- login ----------
$("loginBtn").onclick = async () => {
  const cfg = await call("config");
  const state = crypto.randomUUID();
  sessionStorage.setItem("tt_state", state);
  const q = new URLSearchParams({
    client_key: cfg.client_key, response_type: "code", state,
    scope: "user.info.basic,video.publish,video.upload", redirect_uri: cfg.redirect_uri,
  });
  location.href = "https://www.tiktok.com/v2/auth/authorize/?" + q;
};
$("logout").onclick = (e) => { e.preventDefault(); sessionStorage.clear(); location.href = location.pathname; };

async function finishLogin() {
  const p = new URLSearchParams(location.search);
  if (!p.get("code")) return;
  history.replaceState(null, "", location.pathname);
  if (p.get("state") !== sessionStorage.getItem("tt_state")) return alertBox("Login could not be verified. Please try again.");
  const t = await call("exchange", { code: p.get("code") });
  if (!t.access_token) return alertBox("TikTok did not complete the login: " + (t.error_description || t.error));
  token = t.access_token;
  sessionStorage.setItem("tt_token", token);
}

function alertBox(msg) { const b = $("blocked"); b.textContent = msg; b.classList.remove("hidden"); }

// ---------- creator info (must be queried before showing the composer) ----------
async function loadCreator() {
  const r = await call("creator_info");
  if (r.error && r.error.code !== "ok") {
    if (r.error.code === "access_token_invalid") { sessionStorage.clear(); return false; }
    $("login").classList.add("hidden"); $("composer").classList.remove("hidden");
    $("form").classList.add("hidden");
    alertBox(r.error.code === "spam_risk_too_many_posts"
      ? "You have reached TikTok's posting limit for today. Please try again later."
      : "TikTok can't accept posts from this account right now: " + r.error.message);
    return true;
  }
  creator = r.data;
  $("avatar").src = creator.creator_avatar_url;
  $("nickname").textContent = creator.creator_nickname;
  $("username").textContent = creator.creator_username;
  const sel = $("privacy");
  for (const opt of creator.privacy_level_options) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = PRIVACY_LABELS[opt] || opt;
    sel.appendChild(o);
  }
  for (const [box, off] of [["comment", creator.comment_disabled], ["duet", creator.duet_disabled], ["stitch", creator.stitch_disabled]]) {
    $(box).disabled = !!off;
    if (off) $(box).parentElement.title = "Disabled in your TikTok settings";
  }
  $("login").classList.add("hidden");
  $("composer").classList.remove("hidden");
  return true;
}

// ---------- form rules from TikTok's content sharing guidelines ----------
$("file").onchange = () => {
  const f = $("file").files[0];
  if (!f) return;
  const v = $("preview");
  v.src = URL.createObjectURL(f);
  v.classList.remove("hidden");
  v.onloadedmetadata = () => {
    videoSeconds = v.duration;
    const max = creator.max_video_post_duration_sec;
    $("duration").textContent = videoSeconds > max
      ? `This video is ${Math.round(videoSeconds)} s long. Your account can post videos up to ${max} s.`
      : `${Math.round(videoSeconds)} s · ${(f.size / 1e6).toFixed(1)} MB`;
    validate();
  };
};

function validate() {
  const disclose = $("disclose").checked;
  const yours = $("yourBrand").checked, branded = $("branded").checked;
  $("discloseBox").classList.toggle("hidden", !disclose);
  // Branded content cannot be private.
  const selfOnly = [...$("privacy").options].find((o) => o.value === "SELF_ONLY");
  if (selfOnly) {
    selfOnly.disabled = disclose && branded;
    selfOnly.textContent = selfOnly.disabled ? "Only me (branded content visibility cannot be set to private)" : "Only me";
    if (selfOnly.disabled && $("privacy").value === "SELF_ONLY") $("privacy").value = "";
  }
  const lbl = $("discloseLabel");
  if (disclose && (yours || branded)) {
    lbl.textContent = branded ? "Your video will be labeled as \"Paid partnership\"." : "Your video will be labeled as \"Promotional content\".";
    lbl.classList.remove("hidden");
  } else lbl.classList.add("hidden");
  $("consent").innerHTML = disclose && branded
    ? 'By posting, you agree to TikTok\'s <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Branded Content Policy</a> and <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.'
    : 'By posting, you agree to TikTok\'s <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>.';
  const ok = $("file").files[0] && videoSeconds > 0 && videoSeconds <= creator.max_video_post_duration_sec
    && $("privacy").value && (!disclose || yours || branded);
  $("postBtn").disabled = !ok;
  $("draftBtn").disabled = !($("file").files[0] && videoSeconds > 0);
  $("postBtn").title = disclose && !yours && !branded ? "You need to indicate if your content promotes yourself, a third party, or both." : "";
}
["privacy", "disclose", "yourBrand", "branded"].forEach((id) => $(id).addEventListener("change", validate));

// ---------- post ----------
$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("postBtn").disabled = true;
  const f = $("file").files[0];
  const size = f.size;
  const [chunk, count] = plan(size);
  const post = {
    title: $("title").value,
    privacy_level: $("privacy").value,
    disable_comment: !$("comment").checked,
    disable_duet: !$("duet").checked,
    disable_stitch: !$("stitch").checked,
    brand_content_toggle: $("disclose").checked && $("branded").checked,
    brand_organic_toggle: $("disclose").checked && $("yourBrand").checked,
  };
  log("Sending your video to TikTok…");
  const init = await call("init", { post_info: post, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: count } });
  if (init.error && init.error.code !== "ok") { log("TikTok refused the post: " + init.error.message); $("postBtn").disabled = false; return; }
  const { publish_id } = init.data;
  if (!(await uploadFile(f, init.data.upload_url, chunk, count))) return;
  log("Upload complete. TikTok is processing your video; it can take a few minutes to appear on your profile.");
  await waitFor(publish_id);
};

async function uploadFile(f, upload_url, chunk, count) {
  const size = f.size;
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size - 1 : start + chunk - 1;
    const r = await call("upload", f.slice(start, end + 1), { "x-upload-url": upload_url, "content-range": `bytes ${start}-${end}/${size}` });
    if (r.status >= 300) { log("Upload failed: " + r.body); return false; }
    log(`Uploaded ${Math.round(((end + 1) / size) * 100)}%`);
  }
  return true;
}

const plan = (size) => size <= 10_000_000 ? [size, 1] : [10_000_000, Math.floor(size / 10_000_000)];

async function waitFor(publish_id) {
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    const st = await call("status", { publish_id });
    const s = st.data && st.data.status;
    if (s === "PUBLISH_COMPLETE") { log("Posted! It's now on your TikTok profile."); return; }
    if (s === "SEND_TO_USER_INBOX") { log("Sent! Open the notification in your TikTok app (Inbox) to edit and post it."); return; }
    if (s === "FAILED") { log("TikTok could not post the video: " + st.data.fail_reason); return; }
  }
  log("Still processing. Check TikTok in a few minutes.");
}

$("draftBtn").onclick = async () => {
  $("draftBtn").disabled = true;
  const f = $("file").files[0];
  const [chunk, count] = plan(f.size);
  log("Sending your video to your TikTok inbox…");
  const init = await call("inbox", { source_info: { source: "FILE_UPLOAD", video_size: f.size, chunk_size: chunk, total_chunk_count: count } });
  if (init.error && init.error.code !== "ok") { log("TikTok refused the upload: " + init.error.message); $("draftBtn").disabled = false; return; }
  if (!(await uploadFile(f, init.data.upload_url, chunk, count))) return;
  log("Upload complete. TikTok is processing it.");
  await waitFor(init.data.publish_id);
};

(async () => {
  await finishLogin();
  if (token && (await loadCreator())) return;
  $("login").classList.remove("hidden");
})();
