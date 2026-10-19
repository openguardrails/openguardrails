package internal

import "testing"

func TestDuplicateHttpCallbackCannotDisableOtherRequests(t *testing.T) {
	release := RegisterMockWasmHost(DefaultProxyWAMSHost{})
	defer release()
	currentStateMux.Lock()
	defer currentStateMux.Unlock()
	previous := currentState
	defer func() { currentState = previous }()
	first, next := 0, 0
	root := &pluginContextState{httpCallbacks: map[uint32]*httpCallbackAttribute{
		10: {callback: func(int, int, int) { first++ }, callerContextID: 100},
		11: {callback: func(int, int, int) { next++ }, callerContextID: 200},
	}}
	currentState = &state{pluginContexts: map[uint32]*pluginContextState{1: root}, contextIDToRootID: map[uint32]uint32{100: 1, 200: 1}}
	proxyOnHttpCallResponse(1, 10, 0, 0, 0)
	if first != 1 {
		t.Fatal("first decision not delivered")
	}
	currentState.activeContextID = 777
	for i := 0; i < 3; i++ {
		proxyOnHttpCallResponse(1, 10, 0, 0, 0)
	}
	if first != 1 || next != 0 || currentState.activeContextID != 777 {
		t.Fatal("duplicate response replayed a decision or changed context")
	}
	proxyOnHttpCallResponse(1, 11, 0, 0, 0)
	if first != 1 || next != 1 || currentState.activeContextID != 200 {
		t.Fatal("later request callback lost or misattributed")
	}
	proxyOnHttpCallResponse(1, 99999, 0, 0, 0)
	if first != 1 || next != 1 {
		t.Fatal("unknown callback replayed a decision")
	}
}
