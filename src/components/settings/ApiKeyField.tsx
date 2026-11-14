/** Compatibility exports: provider credentials are managed only by the backend. */
export const useApiKeyEditor = () => ({ managed: true })
export const ApiKeyField = () => <p>模型 API Key 由后端管理。附件、语音和历史导入暂未开放。</p>
export const ApiKeyConfirm = () => null
