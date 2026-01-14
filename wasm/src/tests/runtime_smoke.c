#include "../../include/abi.h"
#include <assert.h>

int main(void) {
  assert(init() == 0);
  assert(reset() == 0);
  return 0;
}
