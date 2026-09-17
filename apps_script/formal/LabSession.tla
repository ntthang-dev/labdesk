---------------------------- MODULE LabSession ----------------------------
(***************************************************************************)
(* Formal model of the session-allocation protocol in apps_script/Code.gs. *)
(*                                                                         *)
(* Two Apps Script Web App requests (e.g. two students clicking "Đăng     *)
(* nhập" within the same second) can execute concurrently. Each `login`   *)
(* is READ-THEN-WRITE against the ActiveSessions sheet: read every row to *)
(* find a free machine and confirm the student has no other session, then *)
(* write `occupied` to the chosen row. Code.gs wraps that read-then-write *)
(* in `LockService.getScriptLock()` (WithLock below); this spec checks    *)
(* what breaks if that lock were ever removed (WithoutLock).              *)
(*                                                                         *)
(* `status` (kick / heartbeat-expiry) and `logout` are NOT under the      *)
(* login/logout lock in Code.gs -- they only ever move a row              *)
(* occupied -> free, never allocate one, so they cannot conflict with a   *)
(* concurrent login regardless of locking. Free below models that: it is  *)
(* always enabled and never contends for TheLock.                        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    Students,    \* e.g. {"s1", "s2"}
    Machines,    \* e.g. {"m1"}, or {"m1","m2"} for a multi-machine lab
    UseLock      \* TRUE = current Code.gs (locked); FALSE = the race it prevents

VARIABLES
    occupant,    \* [Machines -> Students \cup {"none"}]
    pc,          \* [Students -> {"idle","reading","writing"}] -- login in flight
    seen,        \* [Students -> SUBSET Machines] -- free machines this student's
                 \* in-flight login already read (models the read step)
    lockHolder,  \* the student currently holding the script lock, or "none"
    doubleBooked \* history flag: did a write ever land on a row some other
                 \* student was still occupying? (The sheet cell itself can only
                 \* ever hold one value, so "occupant[m] has two owners" can
                 \* never be observed in the final state even when this
                 \* happens -- both students' clients were told `allowed:true`
                 \* for the same machine and one of them silently got
                 \* overwritten. This flag is what actually catches that.)

vars == <<occupant, pc, seen, lockHolder, doubleBooked>>

NoStudent == "none"

TypeOK ==
    /\ occupant \in [Machines -> Students \cup {NoStudent}]
    /\ pc \in [Students -> {"idle", "reading", "writing"}]
    /\ seen \in [Students -> SUBSET Machines]
    /\ lockHolder \in Students \cup {NoStudent}
    /\ doubleBooked \in BOOLEAN

Init ==
    /\ occupant = [m \in Machines |-> NoStudent]
    /\ pc = [s \in Students |-> "idle"]
    /\ seen = [s \in Students |-> {}]
    /\ lockHolder = NoStudent
    /\ doubleBooked = FALSE

StudentHasSession(s) == \E m \in Machines : occupant[m] = s

\* A student starts a login attempt: acquire the lock (if modelled) and begin
\* the read phase that handleLogin() does before writing anything.
StartLogin(s) ==
    /\ pc[s] = "idle"
    /\ ~StudentHasSession(s)
    /\ IF UseLock
       THEN /\ lockHolder = NoStudent
            /\ lockHolder' = s
       ELSE UNCHANGED lockHolder
    /\ pc' = [pc EXCEPT ![s] = "reading"]
    /\ seen' = [seen EXCEPT ![s] = {m \in Machines : occupant[m] = NoStudent}]
    /\ UNCHANGED <<occupant, doubleBooked>>

\* handleLogin() finishes: allocate the first free machine it saw during the
\* read phase (Code.gs takes the first row in sheet order; any element of the
\* set it saw is an equally faithful abstraction of "first free row read").
FinishLogin(s) ==
    /\ pc[s] = "reading"
    /\ seen[s] # {}
    /\ \E m \in seen[s] :
        /\ occupant' = [occupant EXCEPT ![m] = s]
        \* `m` was free when this login's read phase ran (m \in seen[s]), but
        \* someone else may have grabbed it since, if the lock didn't stop
        \* that other login from interleaving in between. Code.gs writes
        \* blindly here, so this is exactly its bug, not an artifact of the
        \* model: a client-visible allowed:true is silently clobbered.
        /\ doubleBooked' = (doubleBooked \/ (occupant[m] # NoStudent /\ occupant[m] # s))
    /\ pc' = [pc EXCEPT ![s] = "idle"]
    /\ seen' = [seen EXCEPT ![s] = {}]
    /\ IF UseLock THEN lockHolder' = NoStudent ELSE UNCHANGED lockHolder

\* handleLogin() finds no free machine (its read phase saw none): denied,
\* same visible end state as never having tried.
NoFreeMachine(s) ==
    /\ pc[s] = "reading"
    /\ seen[s] = {}
    /\ pc' = [pc EXCEPT ![s] = "idle"]
    /\ IF UseLock THEN lockHolder' = NoStudent ELSE UNCHANGED lockHolder
    /\ UNCHANGED <<occupant, seen, doubleBooked>>

\* status()-driven kick/expiry, or logout(): frees one occupied machine.
\* Never touches pc/seen/lockHolder -- Code.gs runs this outside the lock.
Free(m) ==
    /\ occupant[m] # NoStudent
    /\ occupant' = [occupant EXCEPT ![m] = NoStudent]
    /\ UNCHANGED <<pc, seen, lockHolder, doubleBooked>>

Next ==
    \/ \E s \in Students : StartLogin(s)
    \/ \E s \in Students : FinishLogin(s)
    \/ \E s \in Students : NoFreeMachine(s)
    \/ \E m \in Machines : Free(m)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Safety properties Code.gs is supposed to guarantee. *)

\* No login write ever silently clobbers another student's freshly-claimed
\* machine. `occupant` itself (a function) can never show two owners for one
\* machine at once -- that's why `doubleBooked` exists: it is set the
\* instant a write overwrites someone else's occupancy, catching the bug at
\* the moment it happens rather than only in a final state that already
\* hides it.
NoDoubleBooking == ~doubleBooked

\* No student ever holds two machines at once (mirrors the "already has an
\* active session" check at the top of handleLogin()). Included for
\* completeness: StartLogin's precondition already makes this structurally
\* true regardless of UseLock, since a student can't begin a second login
\* while one is in flight or they already hold a machine.
OneMachinePerStudent ==
    \A s \in Students :
        Cardinality({m \in Machines : occupant[m] = s}) <= 1

THEOREM Spec => [](TypeOK /\ NoDoubleBooking /\ OneMachinePerStudent)
=============================================================================
