// src/api.ts
// DeepSeek API 封装

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface BalanceResponse {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'DeepSeekApiError';
  }
}

export async function fetchBalance(apiKey: string): Promise<BalanceResponse> {
  let response: Response;

  try {
    response = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    throw new DeepSeekApiError(`网络请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status === 401) {
    throw new DeepSeekApiError('API Key 无效或已过期，请重新设置', 401);
  }
  if (response.status === 429) {
    throw new DeepSeekApiError('请求频率过高，请稍后再试', 429);
  }
  if (!response.ok) {
    throw new DeepSeekApiError(`API 请求失败: HTTP ${response.status}`, response.status);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new DeepSeekApiError('响应解析失败，API 返回了非 JSON 数据');
  }

  if (!isBalanceResponse(data)) {
    throw new DeepSeekApiError('API 响应格式异常');
  }

  return data;
}

function isBalanceResponse(data: unknown): data is BalanceResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj['is_available'] === 'boolean' &&
    Array.isArray(obj['balance_infos'])
  );
}

export function parsePrimaryBalance(resp: BalanceResponse): {
  total: number;
  currency: string;
} | null {
  const info = resp.balance_infos[0];
  if (!info) return null;

  return {
    total: parseFloat(info.total_balance) || 0,
    currency: info.currency || 'CNY',
  };
}
