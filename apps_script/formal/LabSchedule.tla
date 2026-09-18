---------------------------- MODULE LabSchedule ----------------------------
(***************************************************************************)
(* Formal model of the *booking* protocol added to apps_script/Code.gs      *)
(* (handleBook / handleCancelBooking / reservedForSomeoneElse), the part    *)
(* LabSession.tla does not cover.                                          *)
(*                                                                         *)
(* handleBook is read-then-write against the Schedule sheet, exactly like   *)
(* handleLogin is against ActiveSessions: read every active booking, check  *)
(* (a) this date+slot+machine is free, (b) the student holds no other       *)
(* machine in that slot, (c) the student is under max_bookings_per_week,    *)
(* then append a row. doPost runs it inside LockService.getScriptLock(),    *)
(* and UseLock=FALSE here shows what that lock is actually buying.          *)
(*                                                                         *)
(* handleCancelBooking is deliberately OUTSIDE the lock in Code.gs: it only *)
(* ever moves booked -> cancelled for a row the caller already owns, so it  *)
(* cannot allocate anything. Cancel below models that - always enabled,     *)
(* never contends for the lock.                                            *)
(*                                                                         *)
(* The second thing modelled here is the cross-feature rule that makes      *)
(* booking mean anything at all: a walk-up student logging in must not be   *)
(* handed a machine somebody else reserved for the slot that is running     *)
(* right now (reservedForSomeoneElse, called from handleLogin's free-       *)
(* machine scan). EnforceReservation=FALSE models a build where that check  *)
(* is missing, and must violate NoWalkupStealsReservation - i.e. the check  *)
(* is proven necessary, not just present.                                   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    Students,           \* e.g. {"s1","s2"}
    Machines,           \* e.g. {"m1","m2"}
    Slots,              \* time slots in the bookable window, e.g. {"t1","t2"}
    CurrentSlot,        \* the slot getCurrentSlot() would return "now"
    MaxBookings,        \* Config!max_bookings_per_week (0 = unlimited)
    UseLock,            \* TRUE = current Code.gs; FALSE = the race it prevents
    EnforceReservation  \* TRUE = reservedForSomeoneElse() is called from login

VARIABLES
    booked,       \* [Slots -> [Machines -> Students \cup {"none"}]]
    bpc,          \* [Students -> {"idle","reading"}] -- a book() in flight
    target,       \* [Students -> (Slots \X Machines) \cup {"none"}]
    lockHolder,
    occupant,     \* [Machines -> Students \cup {"none"}] -- live sessions
    doubleBooked, \* history flag: a booking write clobbered someone else's
    stolen        \* history flag: a walk-up login took a reserved machine

vars == <<booked, bpc, target, lockHolder, occupant, doubleBooked, stolen>>

NoStudent == "none"
\* A tuple, not a string: TLC refuses to compare a tuple with a string when
\* checking membership of Pairs \cup {NoTarget}.
NoTarget == <<"none", "none">>

Pairs == Slots \X Machines

BookingsOf(b, s) == {p \in Pairs : b[p[1]][p[2]] = s}

TypeOK ==
    /\ booked \in [Slots -> [Machines -> Students \cup {NoStudent}]]
    /\ bpc \in [Students -> {"idle", "reading"}]
    /\ target \in [Students -> Pairs \cup {NoTarget}]
    /\ lockHolder \in Students \cup {NoStudent}
    /\ occupant \in [Machines -> Students \cup {NoStudent}]
    /\ doubleBooked \in BOOLEAN
    /\ stolen \in BOOLEAN

Init ==
    /\ booked = [sl \in Slots |-> [m \in Machines |-> NoStudent]]
    /\ bpc = [s \in Students |-> "idle"]
    /\ target = [s \in Students |-> NoTarget]
    /\ lockHolder = NoStudent
    /\ occupant = [m \in Machines |-> NoStudent]
    /\ doubleBooked = FALSE
    /\ stolen = FALSE

\* handleBook's read phase: every guard it evaluates before appending a row.
StartBook(s, sl, m) ==
    /\ bpc[s] = "idle"
    /\ booked[sl][m] = NoStudent                        \* slot+machine free
    /\ \A mm \in Machines : booked[sl][mm] # s          \* one machine per slot
    /\ (MaxBookings = 0 \/ Cardinality(BookingsOf(booked, s)) < MaxBookings)
    /\ IF UseLock
       THEN /\ lockHolder = NoStudent
            /\ lockHolder' = s
       ELSE UNCHANGED lockHolder
    /\ bpc' = [bpc EXCEPT ![s] = "reading"]
    /\ target' = [target EXCEPT ![s] = <<sl, m>>]
    /\ UNCHANGED <<booked, occupant, doubleBooked, stolen>>

\* handleBook's write phase: sheet.appendRow(...). Code.gs re-reads nothing
\* here, so without the lock this can land on a row another request claimed
\* in between - which is precisely the bug the lock exists to prevent.
FinishBook(s) ==
    /\ bpc[s] = "reading"
    /\ LET sl == target[s][1]
           m  == target[s][2]
       IN /\ booked' = [booked EXCEPT ![sl][m] = s]
          /\ doubleBooked' = (doubleBooked
                 \/ (booked[sl][m] # NoStudent /\ booked[sl][m] # s))
    /\ bpc' = [bpc EXCEPT ![s] = "idle"]
    /\ target' = [target EXCEPT ![s] = NoTarget]
    /\ IF UseLock THEN lockHolder' = NoStudent ELSE UNCHANGED lockHolder
    /\ UNCHANGED <<occupant, stolen>>

\* handleCancelBooking: owner-only, single row, outside the lock.
Cancel(s, sl, m) ==
    /\ booked[sl][m] = s
    /\ booked' = [booked EXCEPT ![sl][m] = NoStudent]
    /\ UNCHANGED <<bpc, target, lockHolder, occupant, doubleBooked, stolen>>

\* handleLogin's free-machine scan for a student who just walks up.
Reserved(m, s) == booked[CurrentSlot][m] # NoStudent /\ booked[CurrentSlot][m] # s

WalkupLogin(s, m) ==
    /\ occupant[m] = NoStudent
    /\ \A mm \in Machines : occupant[mm] # s
    /\ (EnforceReservation => ~Reserved(m, s))
    /\ occupant' = [occupant EXCEPT ![m] = s]
    /\ stolen' = (stolen \/ Reserved(m, s))
    /\ UNCHANGED <<booked, bpc, target, lockHolder, doubleBooked>>

\* logout / kick / expiry.
Release(m) ==
    /\ occupant[m] # NoStudent
    /\ occupant' = [occupant EXCEPT ![m] = NoStudent]
    /\ UNCHANGED <<booked, bpc, target, lockHolder, doubleBooked, stolen>>

Next ==
    \/ \E s \in Students, sl \in Slots, m \in Machines : StartBook(s, sl, m)
    \/ \E s \in Students : FinishBook(s)
    \/ \E s \in Students, sl \in Slots, m \in Machines : Cancel(s, sl, m)
    \/ \E s \in Students, m \in Machines : WalkupLogin(s, m)
    \/ \E m \in Machines : Release(m)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Safety properties the booking feature is supposed to guarantee. *)

\* Two students are never told "đặt lịch thành công" for the same machine in
\* the same slot. As in LabSession.tla, the sheet cell can only hold one
\* value, so the clobber has to be caught as it happens, not in a final state.
NoDoubleBookedSlot == ~doubleBooked

\* A student never holds two machines in the same slot (handleBook's
\* "Bạn đã đặt một máy khác trong khung giờ này rồi" guard).
OneMachinePerStudentPerSlot ==
    \A s \in Students, sl \in Slots :
        Cardinality({m \in Machines : booked[sl][m] = s}) <= 1

\* max_bookings_per_week is never exceeded. This is the property that the
\* "elapsed bookings counted forever" bug (fixed in 0219d0175) sat next to:
\* the cap must bind, but only on bookings the student still holds.
CapRespected ==
    MaxBookings = 0 \/
        \A s \in Students : Cardinality(BookingsOf(booked, s)) <= MaxBookings

\* A reservation actually reserves: nobody else is handed that machine while
\* the reserved slot is the one running now.
NoWalkupStealsReservation == ~stolen

THEOREM Spec => [](TypeOK /\ NoDoubleBookedSlot /\ OneMachinePerStudentPerSlot
                   /\ CapRespected /\ NoWalkupStealsReservation)
=============================================================================
