/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_LIVEKIT_URL?: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_MAX_MESSAGE_LENGTH?: string;
  readonly VITE_MAX_UPLOAD_MB?: string;
  readonly VITE_KLIPY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
