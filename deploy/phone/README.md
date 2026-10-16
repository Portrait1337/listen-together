# 一起听 · 手机部署包

解压后，先按上一级目录的[安装说明](../安装说明.txt)运行 `phone-setup.sh`。服务目录为 `~/listen-together`，安装依赖后使用 `npm start`，默认端口为 `3000`。

浏览器填昵称创建房间，分享房间码，添加上传音频、本地曲库或在线音乐，即可同步播放和聊天。房间、歌单、聊天只保存在内存中，重启后消失。

## 私人配置

默认读取 `${XDG_CONFIG_HOME:-$HOME/.config}/listen-together` 中的 `cos-config.json` 与 `netease-cookie.txt`。目录可通过 `LISTEN_TOGETHER_CONFIG_DIR` 指定；也支持原有的 `COS_CONFIG_FILE`、`NETEASE_COOKIE_FILE` 和 `NETEASE_COOKIE`。兼容旧版项目根目录配置。

按需把 `cos-config.example.json` 复制到私人目录并填写实际值。私人目录设为 `700`，配置文件设为 `600`。发布包不包含真实凭据，部署者在设备上单独配置；未配置时仍可使用本地上传与普通房间功能。

[DDNS 配置说明](../DDNS配置说明.txt)和 [DDNS 样例](../ddns-config.example.conf)位于解压后的上一级目录。公开地址请按自己的部署填写，例如 `http://listen.example.com:3000`。
