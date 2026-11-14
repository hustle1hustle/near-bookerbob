// A probe for scripts/smith.test.mjs: one action inside zk/smith/sandbox.sb, exit 0 if it worked.
//   sbprobe read <path> | write <path> | rename <from> <to> | net <ipv4> <port> | exec <path>
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  if (!strcmp(argv[1], "read")) {
    char b[16];
    int fd = open(argv[2], O_RDONLY);
    return fd >= 0 && read(fd, b, sizeof b) >= 0 ? 0 : 1;
  }
  if (!strcmp(argv[1], "write")) {
    int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0600);
    return fd >= 0 && write(fd, "x", 1) == 1 ? 0 : 1;
  }
  if (!strcmp(argv[1], "rename") && argc == 4) return rename(argv[2], argv[3]) == 0 ? 0 : 1;
  if (!strcmp(argv[1], "net") && argc == 4) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(atoi(argv[3]))};
    inet_pton(AF_INET, argv[2], &a.sin_addr);
    return s >= 0 && connect(s, (struct sockaddr *)&a, sizeof a) == 0 ? 0 : 1;
  }
  if (!strcmp(argv[1], "exec")) {
    execl(argv[2], argv[2], "-c", "true", (char *)0);
    return 1;
  }
  return 2;
}
