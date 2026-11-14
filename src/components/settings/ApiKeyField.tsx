/** 保留设置页接口，模型凭据仅由后端管理。 */
export const useApiKeyEditor = () => ({ managed: true })
export const ApiKeyField = () => (
  <p>
    模型 API Key 由后端管理。附件经后端上传至 DeepSeek，单文件8 MiB、每消息10个、每账号100个/100
    MiB；仅支持常见图片、PDF和UTF-8文本。新上传图片在当前页面可临时预览（最多20张/32
    MiB缓存），刷新或换设备后仅显示附件信息，不提供原件下载，请自行保留原文件。本项目不提供旧历史导入。语音输入需主动点击并授予麦克风权限；录音和主动朗读的文本经后端发送给
    DeepSeek 处理。
  </p>
)
export const ApiKeyConfirm = () => null
