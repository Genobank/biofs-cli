export interface Credentials {
  wallet_address: string;
  user_signature: string;
  created_at: string;
  expires_at: string;
  last_used?: string;
}

export interface UserConfig {
  default_download_dir?: string;
  api_base_url?: string;
  auth_base_url?: string;
  callback_port?: number;
  auto_open_browser?: boolean;
  show_progress?: boolean;
  cache_duration_ms?: number;
}
