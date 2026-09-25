import { useState } from "react";
import { normalizeWorktreeBranchPrefix } from "@t3tools/shared/git";

import { AppTextInput } from "../../../components/AppText";

export function WorktreeBranchPrefixField(props: {
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (props.disabled) return;
    const prefix = normalizeWorktreeBranchPrefix(draft);
    if (prefix !== props.value) props.onValueChange(prefix);
  };

  return (
    <AppTextInput
      className="min-h-10 w-32 rounded-xl px-3 py-2 text-base"
      value={draft ?? props.value ?? ""}
      placeholder={props.value === null ? "Mixed" : "No prefix"}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      returnKeyType="done"
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      accessibilityLabel="Worktree branch prefix"
      editable={!props.disabled}
    />
  );
}
