/** Local policy: Pi owns the root waiting state; Rex owns every notification. */
export const WAIT_MESSAGE = "Pi 正在等待你回答";

/** Race a bounded UI/load operation with cancellation, and always remove the listener. */
export function abortable<T>(action: () => Promise<T>, signal: AbortSignal, cancelled: T): Promise<T> {
	if (signal.aborted) return Promise.resolve(cancelled);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => finish(() => resolve(cancelled));
		let finished = false;
		const finish = (deliver: () => void) => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", onAbort);
			deliver();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			action().then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
		} catch (error) {
			finish(() => reject(error));
		}
	});
}

/** Only used while an existing capturing overlay blocks the inline slot. */
export function waitForRetry(signal: AbortSignal, milliseconds = 50): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		signal.addEventListener("abort", finish, { once: true });
	});
}

type Release = () => void;
type Waiter = { grant: () => void };

/** FIFO, per extension registration. A cancelled waiter never owns the editor slot. */
export class QuestionnaireQueue {
	private held = false;
	private waiting: Waiter[] = [];

	acquire(signal: AbortSignal): Promise<Release | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				grant: () => {
					signal.removeEventListener("abort", cancel);
					this.held = true;
					let released = false;
					resolve(() => {
						if (released) return;
						released = true;
						this.held = false;
						this.waiting.shift()?.grant();
					});
				},
			};
			const cancel = () => {
				const index = this.waiting.indexOf(waiter);
				if (index !== -1) this.waiting.splice(index, 1);
				signal.removeEventListener("abort", cancel);
				resolve(undefined);
			};
			if (!this.held) waiter.grant();
			else {
				this.waiting.push(waiter);
				signal.addEventListener("abort", cancel, { once: true });
			}
		});
	}
}
