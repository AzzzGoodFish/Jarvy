import type { Part } from "../keys";
import type { connection as en } from "../en/connection";

/** 中文：怎么访问 Jarvy (A51)。 */
export const connection: Part<typeof en> = {
  "connection.lan": "局域网访问",
  "connection.localOnly": "仅限本机",
  "connection.localOnlyHint": "Jarvy 目前只接受这台电脑上的访问。如需在局域网内的其他设备上使用，请用 {flag} 重新启动 Jarvy。",
  "connection.lanHint": "局域网内的其他设备可以通过以下地址访问 Jarvy。",
  "connection.addresses": "访问地址",
  "connection.copy": "复制地址",
  "connection.root": "安全证书",
  "connection.rootHint": "在其他设备上安装后，浏览器会信任与 Jarvy 的连接，不再显示安全警告。",
  "connection.download": "下载证书",
  "connection.fingerprint": "SHA-256 指纹",
  "connection.fingerprintSha1": "SHA-1 指纹",
  "connection.howTo": "安装说明",
  "connection.howMac": "Mac：打开证书将它添加到「钥匙串访问」，双击该证书，在「信任」中将「使用此证书时」设为「始终信任」。",
  "connection.howWindows": "Windows：打开证书，点「安装证书」，选择「将所有的证书都放入下列存储」，再选「受信任的根证书颁发机构」。证书「详细信息」中的「指纹」就是上面的 SHA-1 指纹。",
  "connection.howIos": "iPhone 和 iPad：在 Safari 中下载证书，前往「设置 › 通用 › VPN与设备管理」安装，再在「设置 › 通用 › 关于本机 › 证书信任设置」中针对它启用完全信任。",
  "connection.howAndroid": "Android：下载证书后，在「设置」中搜索「CA 证书」并安装。不同手机的位置不同，通常在「安全」或「加密与凭据」里。",
  "connection.howRestart": "装好后，完全退出浏览器再重新打开，新证书才会生效。",
  "connection.allowHttp": "允许 HTTP 访问",
  "connection.allowHttpHint": "允许其他设备通过未加密的 HTTP 访问。密码和对话内容会以明文传输，可能被同一网络中的他人看到，只建议在可信的网络中开启。",
  "connection.insecure": "当前连接未加密，密码和对话内容可能被同一网络中的他人看到。",
  "connection.useHttps": "切换到 HTTPS",
};
