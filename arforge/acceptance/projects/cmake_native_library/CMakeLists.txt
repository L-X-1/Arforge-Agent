cmake_minimum_required(VERSION 3.20)
project(arforge_project_acceptance VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(policy STATIC src/policy.c)
target_include_directories(policy PUBLIC include)
add_library(ledger STATIC src/ledger.cpp)
target_include_directories(ledger PUBLIC include)
target_link_libraries(ledger PUBLIC policy)

add_executable(acceptance_cli src/main.cpp)
target_link_libraries(acceptance_cli PRIVATE ledger)
add_executable(acceptance_tests tests/acceptance_tests.cpp)
target_link_libraries(acceptance_tests PRIVATE ledger)

add_test(NAME unit COMMAND acceptance_tests unit)
set_tests_properties(unit PROPERTIES LABELS unit)
add_test(NAME integration COMMAND acceptance_tests integration)
set_tests_properties(integration PROPERTIES LABELS integration)
add_test(NAME negative COMMAND acceptance_tests negative)
set_tests_properties(negative PROPERTIES LABELS negative)

install(TARGETS policy ledger acceptance_cli)
set(CPACK_GENERATOR ZIP)
set(CPACK_PACKAGE_FILE_NAME "arforge-native-${PROJECT_VERSION}")
include(CPack)
