/**
 * Retries a promise-returning function with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 1) throw error;
    console.error(
      `Operation failed. Retrying in ${delay}ms... (${retries - 1} attempts left). Error: ${error}`
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
}
