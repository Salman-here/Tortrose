// A late history response must never replace a newer selection or a new chat.
// Capture does not cancel another read; begin/invalidate advance the selection.
export const createConversationRequestGate = () => {
  let generation = 0;
  const capture = () => {
    const requestedGeneration = generation;
    return () => requestedGeneration === generation;
  };
  return {
    capture,
    begin: () => {
      generation += 1;
      return capture();
    },
    invalidate: () => { generation += 1; },
  };
};
