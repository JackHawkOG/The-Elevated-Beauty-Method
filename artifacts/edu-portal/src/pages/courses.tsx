import { useState } from "react";
import { Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout";
import { 
  useListCourses, 
  getListCoursesQueryKey,
  useListCategories, 
  useEnrollInCourse 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Library, BookOpen, Clock, Users, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getListEnrollmentsQueryKey } from "@workspace/api-client-react";

export default function CoursesPage() {
  const [search, setSearch] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | undefined>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: categories, isLoading: categoriesLoading } = useListCategories();
  
  const courseParams = { search: search || undefined, categoryId: selectedCategoryId };
  const { data: courses, isLoading: coursesLoading } = useListCourses(
    courseParams,
    { query: { queryKey: getListCoursesQueryKey(courseParams) } }
  );

  const enrollMutation = useEnrollInCourse({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
        toast({ title: "Enrolled successfully", description: `You are now enrolled in ${data.courseTitle}.` });
        setLocation(`/courses/${data.courseId}`);
      },
      onError: () => {
        toast({ title: "Enrollment failed", description: "You might already be enrolled or there was an error.", variant: "destructive" });
      }
    }
  });

  const handleEnroll = (courseId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    enrollMutation.mutate({ data: { courseId } });
  };

  return (
    <AppLayout>
      <div className="space-y-8 pb-12 max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-serif font-bold text-foreground tracking-tight mb-2">The Method</h1>
            <p className="text-muted-foreground text-lg">Beauty mastery, confidence, and presence — explore every topic.</p>
          </div>
          <div className="relative w-full md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search courses..." 
              className="pl-9 bg-input/50 border-border rounded-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Category Filter */}
        <div>
          {categoriesLoading ? (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-8 w-24 rounded-full bg-muted shrink-0" />)}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Badge 
                variant={selectedCategoryId === undefined ? "default" : "outline"} 
                className={`cursor-pointer rounded-full px-4 py-1.5 text-sm ${selectedCategoryId === undefined ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border-border text-muted-foreground hover:text-foreground'}`}
                onClick={() => setSelectedCategoryId(undefined)}
              >
                All Topics
              </Badge>
              {categories?.map(cat => (
                <Badge 
                  key={cat.id} 
                  variant={selectedCategoryId === cat.id ? "default" : "outline"}
                  className={`cursor-pointer rounded-full px-4 py-1.5 text-sm ${selectedCategoryId === cat.id ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setSelectedCategoryId(cat.id)}
                >
                  {cat.name}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Course Grid */}
        <div>
          {coursesLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <Skeleton key={i} className="h-[360px] w-full rounded-2xl bg-card border border-border" />
              ))}
            </div>
          ) : courses?.length === 0 ? (
            <div className="text-center py-20 border border-dashed border-border rounded-2xl">
              <Library className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-xl font-serif font-bold mb-2">No courses found</h3>
              <p className="text-muted-foreground">Try adjusting your search or category filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {courses?.map(course => (
                <Link key={course.id} href={`/courses/${course.id}`}>
                  <Card className="h-full hover:bg-card/80 transition-all cursor-pointer border-border group overflow-hidden flex flex-col hover:border-primary/30 hover:shadow-[0_8px_30px_-12px_rgba(255,236,194,0.15)]">
                    <div className="h-48 bg-muted relative overflow-hidden">
                      {course.thumbnailUrl ? (
                        <img src={course.thumbnailUrl} alt={course.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/40 group-hover:scale-105 transition-transform duration-500">
                          <Library className="w-12 h-12" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-background/90 to-transparent"></div>
                      <Badge className="absolute bottom-3 left-3 bg-primary/20 text-primary border-primary/20 hover:bg-primary/30 backdrop-blur">
                        {course.categoryName}
                      </Badge>
                      <Badge variant="outline" className="absolute bottom-3 right-3 bg-background/80 backdrop-blur border-border text-foreground">
                        {course.difficulty}
                      </Badge>
                    </div>
                    <CardContent className="p-6 flex-1 flex flex-col">
                      <h3 className="font-serif font-bold text-xl mb-3 group-hover:text-primary transition-colors line-clamp-2 leading-tight">
                        {course.title}
                      </h3>
                      <p className="text-muted-foreground text-sm line-clamp-2 mb-4 leading-relaxed">
                        {course.description}
                      </p>
                      
                      <div className="mt-auto space-y-4">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <div className="flex items-center gap-1"><BookOpen className="w-3.5 h-3.5" /> {course.lessonCount} lessons</div>
                          <div className="flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {course.enrollmentCount}</div>
                        </div>
                        
                        <div className="flex items-center justify-between pt-4 border-t border-border/50">
                          <span className="text-sm font-medium text-foreground">{course.instructorName}</span>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="text-primary hover:text-primary hover:bg-primary/10 rounded-full h-8 px-3"
                            onClick={(e) => handleEnroll(course.id, e)}
                            disabled={enrollMutation.isPending}
                          >
                            {enrollMutation.isPending && enrollMutation.variables?.data.courseId === course.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>Enroll <ChevronRight className="w-4 h-4 ml-1" /></>
                            )}
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}