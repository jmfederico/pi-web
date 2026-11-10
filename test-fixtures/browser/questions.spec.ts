import { expect, test } from "@playwright/test";

for (const short of [false, true]) {
  test(`question actions remain reachable and exclusive with chat${short ? " in a short viewport" : ""}`, async ({ page }, testInfo) => {
    if (short) await page.setViewportSize({ width: 390, height: 430 });
    await page.goto("/questions.html");
    const chat = page.locator("prompt-editor .cm-content");
    const answer = page.getByRole("button", { name: "Send answers", exact: true });
    const discard = page.getByRole("button", { name: "Discard questions", exact: true });
    const normalSend = page.locator('prompt-editor [data-composer-action="send"]');
    await expect(answer).toBeInViewport({ ratio: 1 });
    await expect(discard).toBeInViewport({ ratio: 1 });
    await expect(chat).toBeHidden();
    await expect(normalSend).toBeHidden();
    await page.locator("chat-view .chat").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastAnswer = page.locator("ask-user-card textarea").last();
    await lastAnswer.fill("Keep this answer");
    await lastAnswer.press("Enter");
    await expect(answer).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => window.questionFixture.result())).toEqual({ submissions: [], chats: 0 });
    await page.getByRole("button", { name: "Chat instead", exact: true }).click();
    await expect(chat).toBeVisible();
    await expect(chat).toBeFocused();
    await expect(chat).toHaveText("Unsent chat draft");
    await expect(answer).toBeHidden();
    await expect(discard).toBeHidden();
    await lastAnswer.fill("Edited while chatting");
    await expect(chat).toBeHidden();
    await expect(normalSend).toBeHidden();
    await expect(lastAnswer).toBeFocused();
    await expect(answer).toBeInViewport({ ratio: 1 });
    await answer.click();
    const confirm = page.getByRole("button", { name: "Send anyway", exact: true });
    await expect(confirm).toBeFocused();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(discard).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("question-confirmation.png") });
    await confirm.click();
    await expect(chat).toBeVisible();
    await expect(chat).toHaveText("Unsent chat draft");
    await expect(answer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.questionFixture.result())).toEqual({
      chats: 0, submissions: [{ answers: [{ id: "q11", values: [], otherText: "Edited while chatting" }] }],
    });
  });
}
