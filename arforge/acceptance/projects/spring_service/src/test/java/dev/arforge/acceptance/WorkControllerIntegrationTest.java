package dev.arforge.acceptance;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class WorkControllerIntegrationTest {
    @Autowired MockMvc client;

    @Test
    void createsAndListsItems() throws Exception {
        client.perform(post("/items")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"release\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.status").value("open"));
        client.perform(get("/items"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].title").value("release"));
    }
}
