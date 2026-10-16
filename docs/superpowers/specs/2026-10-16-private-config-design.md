# 私人配置与公开发布

用户已逐项确认：Cookie 副本仅本地保留；运行凭据改存用户目录；公开域名和路径通用化；个人运维文档原文私人保存、仓库保留通用教程；手机部署包脱敏后重新生成。所有改动保留共听、聊天、上传、在线音乐、COS、会员与自启功能。

## 配置契约

- Node 配置查找顺序：显式 `COS_CONFIG_FILE` / `NETEASE_COOKIE_FILE` → `LISTEN_TOGETHER_CONFIG_DIR` 中已有文件 → 旧版项目根目录文件。默认私人目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/listen-together`。显式路径不存在时不回退到其他凭据。
- `NETEASE_COOKIE` 内容仍优先于文件；Cookie 文件轮询和 COS 行为保持不变。
- 本地迁移逐字节校验后保留旧路径兼容链接，使已有进程仍可读取；链接与副本由 Git、部署同步和打包规则排除。
- DDNS 从私人 `ddns.conf` 读取 `DOMAIN` / `SUB_DOMAIN` / `ID` / `TOKEN`；`DNSPOD_CONFIG_FILE` 可指定文件，`DNSPOD_DOMAIN` / `DNSPOD_SUB_DOMAIN` / `DNSPOD_ID` / `DNSPOD_TOKEN` 优先覆盖。缺少必需配置时在发出请求前报错。
- cpolar 仓库保存通用 plist 模板；安装器在本机生成绝对路径，配置存 `cpolar.conf`。正常安装迁移旧 LaunchAgent，`--no-load` 供本机检查。现有运行服务可继续使用原注册标识与兼容路径，待主动重新安装时迁移。

## 发布与验证

云部署同步按 `.gitignore` 排除私人文件，且保留目标端已有忽略文件。手机 ZIP 从明确清单构建，只包含当前运行代码、静态资源、通用安装说明和示例配置；不分发凭据与私人运维原文。

原文与旧包保存在项目外私人目录。仓库文档不包含实际用户名、个人设备绝对路径、个人域名、家庭实测拓扑或手机 SSH 账号。

验证使用临时配置和桩服务，不以真实凭据进行网络验证；测试日志只报告合成夹具和匹配结果。配置优先级、DDNS、plist 渲染和发布包均需真实执行验证，再运行全量 `node --test` 和本地使用流程。
