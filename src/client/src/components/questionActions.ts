import { css, type TemplateResult } from "lit";

/**
 * The question form owns answers and submission; the layout only presents its actions.
 * Both rendering hosts include questionActionStyles and the shared button styles.
 */
export interface QuestionActions {
  key: string;
  editVersion: number;
  content: TemplateResult;
  focus: () => void;
}

export type QuestionActionsCallback = (actions: QuestionActions | undefined) => void;

export const questionActionStyles = css`
  .form-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 12px;
    border-top: 1px solid var(--pi-border-muted);
    padding: 12px 16px;
  }
  .partial-confirmation { min-width: 0; flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
  .partial-prompt { min-width: 0; color: var(--pi-warning); font-size: 12px; line-height: 1.4; }
  .partial-prompt p { margin: 0; }
  .partial-prompt ul { margin: 4px 0 0; padding-inline-start: 18px; max-height: 15vh; overflow-y: auto; }
  .partial-prompt li { overflow-wrap: anywhere; }
  .question-jump {
    display: inline; border: 0; border-radius: 3px; background: transparent; color: inherit;
    padding: 0; font: inherit; text-align: start; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
  }
  .question-jump:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
  .confirmation-actions { display: flex; flex-wrap: wrap; align-items: stretch; justify-content: flex-end; gap: 0; }
  @container (max-width: 580px) {
    .form-footer { padding: 12px; }
    .partial-confirmation { flex-basis: 100%; align-items: stretch; flex-direction: column; }
  }
`;
