// The first run (A96): the person types Jarvy's address; over HTTPS its root certificate's fingerprint is shown to
// compare with Settings › 网络 before anything is trusted.
const setup = window.jarvySetup;
const words = setup.chinese ? {
  title: "连接到 Jarvy", intro: "输入 Jarvy 的地址。登录后，这台电脑会接入 Jarvy，授权给 Bot 后 Bot 才能在这里工作。", label: "地址", next: "下一步",
  checkTitle: "核对证书指纹", checkIntro: "在 Jarvy 的「设置 › 网络」里找到证书指纹，确认和下面的一致。", back: "返回", accept: "一致，继续",
  checking: "正在连接…", empty: "请输入地址",
} : {
  title: "Connect to Jarvy", intro: "Enter Jarvy's address. Once you sign in, this computer connects to Jarvy; Bots can work here after you grant it to them.", label: "Address", next: "Next",
  checkTitle: "Check the certificate fingerprint", checkIntro: "Find the certificate fingerprint in Jarvy's Settings › Network and make sure it matches this one.", back: "Back", accept: "It matches",
  checking: "Connecting…", empty: "Enter an address",
};
for (const node of document.querySelectorAll("[data-t]")) node.textContent = words[node.dataset.t];
document.documentElement.lang = setup.chinese ? "zh-CN" : "en";
const $ = id => document.getElementById(id);
const form = $("address"), check = $("check"), input = $("server"), next = form.querySelector("button");
let address = "";
form.addEventListener("submit", async event => {
  event.preventDefault();
  $("address-error").textContent = "";
  if (!input.value.trim()) { $("address-error").textContent = words.empty; return; }
  next.disabled = true; next.textContent = words.checking;
  const result = await setup.probe(input.value.trim());
  next.disabled = false; next.textContent = words.next;
  if (result.error) { $("address-error").textContent = result.error; return; }
  address = result.server;
  if (!result.fingerprint) { await setup.accept(address); return; }
  $("fingerprint").textContent = result.fingerprint;
  form.hidden = true; check.hidden = false; $("accept").focus();
});
$("back").addEventListener("click", () => { check.hidden = true; form.hidden = false; input.focus(); });
$("accept").addEventListener("click", async () => {
  $("accept").disabled = true;
  const result = await setup.accept(address);
  $("accept").disabled = false;
  if (result?.error) $("check-error").textContent = result.error;
});
