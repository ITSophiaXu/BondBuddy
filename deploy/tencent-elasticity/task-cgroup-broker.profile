abi <abi/3.0>,
#include <tunables/global>
profile bondbuddy-task-cgroups-v1 flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  network unix,
  capability chown,
  capability dac_override,
  capability dac_read_search,
  capability fowner,
  capability sys_ptrace,
  file,
  signal (receive) peer=unconfined,
  ptrace (read) peer=bondbuddy-codex-v1,
}
